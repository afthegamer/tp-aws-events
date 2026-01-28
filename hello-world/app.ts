import type {APIGatewayProxyEventV2, APIGatewayProxyResultV2} from 'aws-lambda';
import {randomUUID} from 'crypto';

import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {isValidIso8601, MAX_DESCRIPTION, MAX_LOCATION, MAX_TITLE, normalizeString, validateMaxLen,} from './validation';

const TABLE_NAME = process.env.EVENTS_TABLE;
const BUCKET_NAME = process.env.EVENTS_BUCKET;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
    return {
        statusCode,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
        },
        body: JSON.stringify(body),
    };
}

function noContent(): APIGatewayProxyResultV2 {
    return {
        statusCode: 204,
        headers: { 'access-control-allow-origin': '*' },
    };
}

function badRequest(message: string, extra?: Record<string, unknown>) {
    return json(400, { error: message, ...(extra ?? {}) });
}

function notFound(message = 'Not Found', extra?: Record<string, unknown>) {
    return json(404, { error: message, ...(extra ?? {}) });
}

function requireTable(): string {
    if (!TABLE_NAME) throw new Error('Missing env var EVENTS_TABLE');
    return TABLE_NAME;
}

function requireBucket(): string {
    if (!BUCKET_NAME) throw new Error('Missing env var EVENTS_BUCKET');
    return BUCKET_NAME;
}

function readRawBody(event: APIGatewayProxyEventV2): string {
    const body = event.body ?? '';
    if (!body) return '';
    if (event.isBase64Encoded) return Buffer.from(body, 'base64').toString('utf-8');
    return body;
}

function parseJsonBody<T>(
    event: APIGatewayProxyEventV2,
): { ok: true; value: T } | { ok: false; res: APIGatewayProxyResultV2 } {
    const raw = readRawBody(event).trim();
    if (!raw) return { ok: false, res: badRequest('Missing body') };

    try {
        return { ok: true, value: JSON.parse(raw) as T };
    } catch {
        return {
            ok: false,
            res: badRequest('Body must be valid JSON', {
                receivedPreview: raw.slice(0, 200),
                receivedLength: raw.length,
                contentType: event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? null,
                isBase64Encoded: !!event.isBase64Encoded,
            }),
        };
    }
}

function getIdFromPath(event: APIGatewayProxyEventV2, re: RegExp): string | null {
    const p = event.pathParameters?.id;
    if (p && typeof p === 'string') return decodeURIComponent(p);
    const m = event.rawPath.match(re);
    if (!m) return null;
    return decodeURIComponent(m[1]);
}

function isConditionalCheckFailed(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((err as any).name === 'ConditionalCheckFailedException' ||
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (err as any).Code === 'ConditionalCheckFailedException')
    );
}

function validateOptionalString(
    field: string,
    value: unknown,
    maxLen: number,
): string | null | undefined | { error: APIGatewayProxyResultV2 } {
    const normalized = normalizeString(value);
    if (normalized === 'TYPE_ERROR') return { error: badRequest(`Field "${field}" must be a string`) };
    if (normalized === undefined) return undefined;
    if (normalized === null) return null;

    if (!validateMaxLen(normalized, maxLen)) {
        return { error: badRequest(`Field "${field}" exceeds max length`, { field, maxLen }) };
    }
    return normalized;
}

type CreateEventBody = {
    title: string;
    date: string;
    location?: string | null;
    description?: string | null;
};

type UpdateEventBody = {
    title?: string | null;
    date?: string | null;
    location?: string | null;
    description?: string | null;
};

function logJson(level: 'info' | 'error', payload: Record<string, unknown>) {
    // logs structurés JSON
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level, ...payload }));
}

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    // GET /hello
    if (method === 'GET' && path === '/hello') {
        return json(200, { message: 'hello world' });
    }

    // GET /events
    if (method === 'GET' && path === '/events') {
        const tableName = requireTable();

        const out = await ddb.send(
            new ScanCommand({
                TableName: tableName,
                Limit: 50,
            }),
        );

        const items = (out.Items ?? [])
            .filter((x) => typeof x?.pk === 'string' && (x.pk as string).startsWith('EVENT#'))
            .map((x) => ({
                eventId: (x.pk as string).replace('EVENT#', ''),
                title: x.title,
                date: x.date,
                location: x.location ?? null,
                description: x.description ?? null,
                imageKey: x.imageKey ?? null,
                createdAt: x.createdAt,
                updatedAt: x.updatedAt,
            }));

        return json(200, { items });
    }

    // POST /events
    if (method === 'POST' && path === '/events') {
        const parsed = parseJsonBody<CreateEventBody>(event);
        if (!parsed.ok) return parsed.res;

        const payload = parsed.value;

        if (!payload.title || typeof payload.title !== 'string') {
            return badRequest('Field "title" is required (string)');
        }
        const title = payload.title.trim();
        if (!title) return badRequest('Field "title" cannot be empty');
        if (!validateMaxLen(title, MAX_TITLE))
            return badRequest('Field "title" exceeds max length', { maxLen: MAX_TITLE });

        if (!payload.date || typeof payload.date !== 'string') {
            return badRequest('Field "date" is required (ISO 8601 string)');
        }
        const date = payload.date.trim();
        if (!isValidIso8601(date)) {
            return badRequest('Field "date" must be a valid ISO 8601 date (e.g. 2026-01-27 or 2026-01-27T10:00:00Z)');
        }

        const vLocation = validateOptionalString('location', payload.location, MAX_LOCATION);
        if (typeof vLocation === 'object' && vLocation && 'error' in vLocation) return vLocation.error;
        const vDescription = validateOptionalString('description', payload.description, MAX_DESCRIPTION);
        if (typeof vDescription === 'object' && vDescription && 'error' in vDescription) return vDescription.error;

        const tableName = requireTable();
        const eventId = randomUUID();
        const now = new Date().toISOString();

        const item = {
            pk: `EVENT#${eventId}`,
            title,
            date,
            location: vLocation ?? null,
            description: vDescription ?? null,
            imageKey: null,
            createdAt: now,
            updatedAt: now,
        };

        await ddb.send(new PutCommand({ TableName: tableName, Item: item }));

        return json(201, {
            eventId,
            title: item.title,
            date: item.date,
            location: item.location,
            description: item.description,
            imageKey: item.imageKey,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
        });
    }

    // GET /events/{id}
    if (method === 'GET' && /^\/events\/[^/]+$/.test(path)) {
        const id = getIdFromPath(event, /^\/events\/([^/]+)$/);
        if (!id) return notFound();

        const tableName = requireTable();
        const pk = `EVENT#${id}`;

        const out = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk } }));
        if (!out.Item) return notFound('Event not found', { eventId: id });

        return json(200, {
            eventId: id,
            title: out.Item.title,
            date: out.Item.date,
            location: out.Item.location ?? null,
            description: out.Item.description ?? null,
            imageKey: out.Item.imageKey ?? null,
            createdAt: out.Item.createdAt,
            updatedAt: out.Item.updatedAt,
        });
    }

    // PUT /events/{id}
    if (method === 'PUT' && /^\/events\/[^/]+$/.test(path)) {
        const id = getIdFromPath(event, /^\/events\/([^/]+)$/);
        if (!id) return notFound();

        const parsed = parseJsonBody<UpdateEventBody>(event);
        if (!parsed.ok) return parsed.res;

        const payload = parsed.value;

        // Validation par champ, uniquement si présent
        if ('title' in payload) {
            if (payload.title !== null && typeof payload.title !== 'string')
                return badRequest('Field "title" must be a string or null');
            if (typeof payload.title === 'string') {
                const t = payload.title.trim();
                if (!t) return badRequest('Field "title" cannot be empty');
                if (!validateMaxLen(t, MAX_TITLE))
                    return badRequest('Field "title" exceeds max length', { maxLen: MAX_TITLE });
                payload.title = t;
            }
        }

        if ('date' in payload) {
            if (payload.date !== null && typeof payload.date !== 'string')
                return badRequest('Field "date" must be a string or null');
            if (typeof payload.date === 'string') {
                const d = payload.date.trim();
                if (!isValidIso8601(d)) return badRequest('Field "date" must be ISO 8601');
                payload.date = d;
            }
        }

        const vLocation = validateOptionalString('location', payload.location, MAX_LOCATION);
        if (typeof vLocation === 'object' && vLocation && 'error' in vLocation) return vLocation.error;
        if (vLocation !== undefined) payload.location = vLocation;

        const vDescription = validateOptionalString('description', payload.description, MAX_DESCRIPTION);
        if (typeof vDescription === 'object' && vDescription && 'error' in vDescription) return vDescription.error;
        if (vDescription !== undefined) payload.description = vDescription;

        const tableName = requireTable();
        const pk = `EVENT#${id}`;
        const now = new Date().toISOString();

        const sets: string[] = [];
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};

        const addSet = (field: keyof UpdateEventBody) => {
            if (!(field in payload)) return;
            names[`#${field}`] = field;
            values[`:${field}`] = payload[field] ?? null;
            sets.push(`#${field} = :${field}`);
        };

        addSet('title');
        addSet('date');
        addSet('location');
        addSet('description');

        // updatedAt toujours mis à jour si on update quelque chose
        names['#updatedAt'] = 'updatedAt';
        values[':updatedAt'] = now;
        sets.push('#updatedAt = :updatedAt');

        // Si l’utilisateur n’a fourni aucun champ updatable (hors updatedAt), on refuse
        if (sets.length === 1) return badRequest('No updatable fields provided');

        try {
            const out = await ddb.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { pk },
                    ConditionExpression: 'attribute_exists(pk)',
                    UpdateExpression: `SET ${sets.join(', ')}`,
                    ExpressionAttributeNames: names,
                    ExpressionAttributeValues: values,
                    ReturnValues: 'ALL_NEW',
                }),
            );

            return json(200, {
                eventId: id,
                title: out.Attributes?.title,
                date: out.Attributes?.date,
                location: out.Attributes?.location ?? null,
                description: out.Attributes?.description ?? null,
                imageKey: out.Attributes?.imageKey ?? null,
                createdAt: out.Attributes?.createdAt,
                updatedAt: out.Attributes?.updatedAt,
            });
        } catch (e) {
            if (isConditionalCheckFailed(e)) return notFound('Event not found', { eventId: id });
            throw e;
        }
    }

    // DELETE /events/{id}
    if (method === 'DELETE' && /^\/events\/[^/]+$/.test(path)) {
        const id = getIdFromPath(event, /^\/events\/([^/]+)$/);
        if (!id) return notFound();

        const tableName = requireTable();
        const pk = `EVENT#${id}`;

        await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk } }));
        return noContent();
    }

    // POST /events/{id}/upload-url  (SPEC)
    if (method === 'POST' && /^\/events\/[^/]+\/upload-url$/.test(path)) {
        const id = getIdFromPath(event, /^\/events\/([^/]+)\/upload-url$/);
        if (!id) return notFound();

        const parsed = parseJsonBody<{ contentType?: string }>(event);
        if (!parsed.ok) return parsed.res;

        const contentType = parsed.value.contentType ?? 'application/octet-stream';
        if (typeof contentType !== 'string' || !contentType.includes('/')) {
            return badRequest('Field "contentType" must be a valid MIME type (e.g. image/jpeg)');
        }

        // (optionnel) restreindre aux types image pour éviter n’importe quoi
        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
        if (!allowed.has(contentType)) {
            return badRequest('Unsupported contentType. Allowed: image/jpeg, image/png, image/webp', {
                received: contentType,
            });
        }

        const tableName = requireTable();
        const bucket = requireBucket();
        const pk = `EVENT#${id}`;
        const now = new Date().toISOString();

        const imageKey = `events/${id}/${randomUUID()}`;

        // On stocke imageKey (et updatedAt) sur l’event
        try {
            await ddb.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { pk },
                    ConditionExpression: 'attribute_exists(pk)',
                    UpdateExpression: 'SET #imageKey = :k, #updatedAt = :u',
                    ExpressionAttributeNames: { '#imageKey': 'imageKey', '#updatedAt': 'updatedAt' },
                    ExpressionAttributeValues: { ':k': imageKey, ':u': now },
                }),
            );
        } catch (e) {
            if (isConditionalCheckFailed(e)) return notFound('Event not found', { eventId: id });
            throw e;
        }

        // Presigned PUT (300s)
        const putCmd = new PutObjectCommand({
            Bucket: bucket,
            Key: imageKey,
            ContentType: contentType,
        });

        const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });

        return json(200, {
            eventId: id,
            imageKey,
            uploadUrl,
            method: 'PUT',
            expiresIn: 300,
            contentType,
        });
    }

    return notFound('Not Found', { method, path });
}

export const lambdaHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const start = Date.now();

    const requestId = event.requestContext.requestId;
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const routeKey = event.requestContext.routeKey;

    try {
        const res = await route(event);

        logJson('info', {
            requestId,
            method,
            path,
            routeKey,
            statusCode: typeof res === 'string' ? 200 : res.statusCode ?? 200,
            durationMs: Date.now() - start,
        });

        return res;
    } catch (err) {
        logJson('error', {
            requestId,
            method,
            path,
            routeKey,
            durationMs: Date.now() - start,
            errorName: err instanceof Error ? err.name : 'UnknownError',
            errorMessage: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack : undefined,
        });

        return json(500, { error: 'Internal Server Error' });
    }
};
