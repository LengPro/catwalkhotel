interface AppEnv {
	FIREBASE_PROJECT_ID: string;
	FIREBASE_CLIENT_EMAIL: string;
	FIREBASE_PRIVATE_KEY: string;
	LINE_CHANNEL_SECRET: string;
	LINE_CHANNEL_ACCESS_TOKEN?: string;
}

type LineWebhookBody = {
	events?: Array<{
		type: string;
		webhookEventId?: string;
		timestamp?: number;
		source?: { type?: string; userId?: string };
		message?: { id?: string; type?: string; text?: string; packageId?: string; stickerId?: string };
	}>;
};

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return json({ ok: true, service: "catwalk-line-webhook" });
		}

		if (request.method !== "POST" || url.pathname !== "/webhook") {
			return new Response("Not found", { status: 404 });
		}

		const bodyText = await request.text();
		const signature = request.headers.get("x-line-signature") || "";

		if (!(await isValidLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET))) {
			return json({ ok: false, error: "invalid_signature" }, 401);
		}

		const payload = JSON.parse(bodyText) as LineWebhookBody;
		await Promise.all((payload.events || []).map((event) => saveLineEvent(env, event)));

		return json({ ok: true });
	},
} satisfies ExportedHandler<AppEnv>;

async function saveLineEvent(env: AppEnv, event: NonNullable<LineWebhookBody["events"]>[number]) {
	const userId = event.source?.userId;
	if (!userId) return;

	const messageId = event.message?.id || event.webhookEventId || `${event.timestamp || Date.now()}`;
	const messageType = event.message?.type || event.type;
	const text = event.message?.type === "text" ? event.message.text || "" : "";
	const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
	const [profile, media] = await Promise.all([
		fetchLineProfile(env, userId),
		fetchLineMessageContent(env, event.message?.id, messageType),
	]);
	const lastMessage = text || media?.label || getMessageLabel(event.message);
	const threadFields: Record<string, unknown> = {
		lineUserId: stringValue(userId),
		lastMessage: stringValue(lastMessage),
		lastMessageAt: timestampValue(timestamp),
		updatedAt: timestampValue(new Date().toISOString()),
		createdFrom: stringValue("line-webhook"),
	};
	if (profile?.displayName) threadFields.displayName = stringValue(profile.displayName);
	if (profile?.pictureUrl) threadFields.pictureUrl = stringValue(profile.pictureUrl);

	const messageFields: Record<string, unknown> = {
		direction: stringValue("in"),
		lineUserId: stringValue(userId),
		lineMessageId: stringValue(messageId),
		eventType: stringValue(event.type),
		type: stringValue(messageType),
		text: stringValue(text),
		timestamp: timestampValue(timestamp),
		createdAt: timestampValue(new Date().toISOString()),
	};
	if (media?.dataUrl) messageFields.mediaUrl = stringValue(media.dataUrl);
	if (media?.contentType) messageFields.mediaContentType = stringValue(media.contentType);
	if (media?.tooLarge) messageFields.mediaTooLarge = booleanValue(true);
	if (event.message?.packageId) messageFields.stickerPackageId = stringValue(event.message.packageId);
	if (event.message?.stickerId) messageFields.stickerId = stringValue(event.message.stickerId);

	await Promise.all([
		writeFirestoreDocument(env, `lineThreads/${userId}`, threadFields),
		writeFirestoreDocument(env, `lineThreads/${userId}/messages/${messageId}`, messageFields),
	]);
}

function getMessageLabel(message: NonNullable<LineWebhookBody["events"]>[number]["message"]) {
	if (!message) return "[event]";
	if (message.type === "sticker") return "[sticker]";
	if (message.type === "image") return "[image]";
	if (message.type === "video") return "[video]";
	if (message.type === "audio") return "[audio]";
	if (message.type === "file") return "[file]";
	if (message.type === "location") return "[location]";
	return `[${message.type || "message"}]`;
}

async function fetchLineProfile(env: AppEnv, userId: string) {
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
	const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
		headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
	});
	if (!response.ok) {
		console.warn(`LINE profile fetch failed: ${response.status} ${await response.text()}`);
		return null;
	}
	return (await response.json()) as { displayName?: string; pictureUrl?: string };
}

async function fetchLineMessageContent(env: AppEnv, messageId: string | undefined, messageType: string) {
	if (!env.LINE_CHANNEL_ACCESS_TOKEN || !messageId || messageType !== "image") return null;
	const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
		headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
	});
	if (!response.ok) {
		console.warn(`LINE content fetch failed: ${response.status} ${await response.text()}`);
		return { label: "[image]" };
	}
	const contentType = response.headers.get("content-type") || "image/jpeg";
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > 700000) {
		return { label: "[image too large]", contentType, tooLarge: true };
	}
	return {
		label: "[image]",
		contentType,
		dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}`,
	};
}

async function writeFirestoreDocument(env: AppEnv, documentPath: string, fields: Record<string, unknown>) {
	const token = await getGoogleAccessToken(env);
	const url = new URL(
		`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${documentPath}`,
	);
	for (const fieldPath of Object.keys(fields)) {
		url.searchParams.append("updateMask.fieldPaths", fieldPath);
	}
	const response = await fetch(url, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ fields }),
	});

	if (!response.ok) {
		throw new Error(`Firestore write failed: ${response.status} ${await response.text()}`);
	}
}

async function getGoogleAccessToken(env: AppEnv) {
	const now = Math.floor(Date.now() / 1000);
	if (cachedGoogleToken && cachedGoogleToken.expiresAt - 60 > now) {
		return cachedGoogleToken.token;
	}

	const jwt = await signGoogleJwt(env, now);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}),
	});

	if (!response.ok) {
		throw new Error(`Google token failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as { access_token: string; expires_in: number };
	cachedGoogleToken = { token: data.access_token, expiresAt: now + data.expires_in };
	return data.access_token;
}

async function signGoogleJwt(env: AppEnv, now: number) {
	const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
	const payload = base64UrlJson({
		iss: env.FIREBASE_CLIENT_EMAIL,
		scope: "https://www.googleapis.com/auth/datastore",
		aud: "https://oauth2.googleapis.com/token",
		iat: now,
		exp: now + 3600,
	});
	const signingInput = `${header}.${payload}`;
	const privateKey = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem: string) {
	const pem = privateKeyPem.replace(/\\n/g, "\n");
	const base64 = pem
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\s/g, "");
	const keyBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

	return crypto.subtle.importKey(
		"pkcs8",
		keyBytes,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function isValidLineSignature(bodyText: string, signature: string, channelSecret: string) {
	if (!signature) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(channelSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
	const expected = bytesToBase64(new Uint8Array(digest));

	return constantTimeEqual(expected, signature);
}

function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

function stringValue(value: string) {
	return { stringValue: value };
}

function timestampValue(value: string) {
	return { timestampValue: value };
}

function booleanValue(value: boolean) {
	return { booleanValue: value };
}

function base64UrlJson(value: unknown) {
	return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array) {
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}
