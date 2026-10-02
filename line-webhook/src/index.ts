interface AppEnv {
	FIREBASE_PROJECT_ID: string;
	FIREBASE_CLIENT_EMAIL: string;
	FIREBASE_PRIVATE_KEY: string;
	FIREBASE_WEB_API_KEY?: string;
	OWNER_EMAILS?: string;
	LINE_CHANNEL_SECRET: string;
	LINE_CHANNEL_ACCESS_TOKEN?: string;
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
}

type LineEvent = {
	type: string;
	webhookEventId?: string;
	timestamp?: number;
	source?: { type?: string; userId?: string };
	message?: { id?: string; type?: string; text?: string; packageId?: string; stickerId?: string };
};

type LineWebhookBody = { events?: LineEvent[] };

type LineMessageInput = {
	id?: string;
	threadId?: string;
	direction?: string;
	lineUserId?: string;
	lineMessageId?: string;
	eventType?: string;
	type?: string;
	text?: string;
	mediaUrl?: string;
	mediaContentType?: string;
	mediaTooLarge?: boolean;
	stickerPackageId?: string;
	stickerId?: string;
	senderType?: string;
	senderName?: string;
	importedFrom?: string;
	mergedFrom?: string;
	timestamp?: string;
	importedAt?: string;
	mergedAt?: string;
};

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") return corsResponse(null, 204);

		if (request.method === "GET" && url.pathname === "/") {
			return json({
				ok: true,
				service: "catwalk-line-webhook",
				version: "line-supabase-2026-10-03",
				hasLineAccessToken: !!env.LINE_CHANNEL_ACCESS_TOKEN,
				hasSupabase: hasSupabase(env),
				hasFirebaseWebApiKey: !!env.FIREBASE_WEB_API_KEY,
			});
		}

		if (request.method === "POST" && url.pathname === "/webhook") {
			return handleLineWebhook(request, env);
		}

		if (url.pathname.startsWith("/line/")) {
			const auth = await requireStaff(request, env);
			if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
			return handleLineApi(request, env, url);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<AppEnv>;

async function handleLineWebhook(request: Request, env: AppEnv) {
	const bodyText = await request.text();
	const signature = request.headers.get("x-line-signature") || "";

	if (!(await isValidLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET))) {
		return json({ ok: false, error: "invalid_signature" }, 401);
	}

	const payload = JSON.parse(bodyText) as LineWebhookBody;
	await Promise.all((payload.events || []).map((event) => saveLineEvent(env, event)));

	return json({ ok: true });
}

async function handleLineApi(request: Request, env: AppEnv, url: URL) {
	if (!hasSupabase(env)) return json({ ok: false, error: "missing_supabase_config" }, 500);

	if (request.method === "GET" && url.pathname === "/line/threads") {
		const rows = await supabaseSelect(env, "line_threads", {
			select: "*",
			order: "last_message_at.desc.nullslast",
			limit: String(clampInt(url.searchParams.get("limit"), 1, 200, 100)),
		});
		return json({ ok: true, threads: rows });
	}

	const messagesMatch = url.pathname.match(/^\/line\/threads\/([^/]+)\/messages$/);
	if (request.method === "GET" && messagesMatch) {
		const rows = await supabaseSelect(env, "line_messages", {
			select: "*",
			thread_id: `eq.${decodeURIComponent(messagesMatch[1])}`,
			order: "timestamp.asc.nullslast,created_at.asc",
			limit: String(clampInt(url.searchParams.get("limit"), 1, 3000, 1000)),
		});
		return json({ ok: true, messages: rows });
	}

	const renameMatch = url.pathname.match(/^\/line\/threads\/([^/]+)\/rename$/);
	if (request.method === "POST" && renameMatch) {
		const body = (await request.json()) as { crmDisplayName?: string };
		await supabaseUpsert(env, "line_threads", [{
			id: decodeURIComponent(renameMatch[1]),
			crm_display_name: cleanString(body.crmDisplayName),
			updated_at: new Date().toISOString(),
		}]);
		return json({ ok: true });
	}

	const threadMatch = url.pathname.match(/^\/line\/threads\/([^/]+)$/);
	if (request.method === "DELETE" && threadMatch) {
		await supabaseDelete(env, "line_threads", { id: `eq.${decodeURIComponent(threadMatch[1])}` });
		return json({ ok: true });
	}

	if (request.method === "POST" && url.pathname === "/line/import") {
		const body = (await request.json()) as {
			targetId?: string;
			userName?: string;
			fileName?: string;
			accountName?: string;
			messages?: LineMessageInput[];
		};
		const messages = Array.isArray(body.messages) ? body.messages : [];
		if (messages.length === 0) return json({ ok: false, error: "no_messages" }, 400);

		const threadId = body.targetId || lineSafeId(body.userName || "Imported LINE");
		const now = new Date().toISOString();
		const last = messages[messages.length - 1];
		await supabaseUpsert(env, "line_threads", [{
			id: threadId,
			crm_display_name: cleanString(body.userName),
			display_name: body.targetId ? undefined : cleanString(body.userName),
			last_message: messagePreview(last),
			last_message_at: toIso(last.timestamp) || now,
			source: "line_csv_import",
			created_from: "line_csv_import",
			import_file_name: cleanString(body.fileName),
			imported_message_count: messages.length,
			updated_at: now,
		}]);

		const rows = messages.map((message, index) => toSupabaseMessage({
			...message,
			id: message.id || `csv_${lineHash([threadId, message.timestamp, message.senderType, message.senderName, message.text, index].join("|"))}`,
			threadId,
			importedFrom: message.importedFrom || "line_csv",
			importedAt: message.importedAt || now,
		}));
		await supabaseUpsert(env, "line_messages", rows);

		return json({ ok: true, threadId, imported: rows.length });
	}

	if (request.method === "POST" && url.pathname === "/line/merge") {
		const body = (await request.json()) as { targetId?: string; sourceIds?: string[] };
		const targetId = String(body.targetId || "").trim();
		const sourceIds = (body.sourceIds || []).map((id) => String(id).trim()).filter(Boolean).filter((id) => id !== targetId);
		if (!targetId || sourceIds.length === 0) return json({ ok: false, error: "missing_merge_ids" }, 400);

		const now = new Date().toISOString();
		for (const sourceId of sourceIds) {
			await supabasePatch(env, "line_messages", {
				thread_id: targetId,
				merged_from: sourceId,
				merged_at: now,
			}, { thread_id: `eq.${sourceId}` });
		}
		const rows = await supabaseSelect(env, "line_threads", {
			select: "id,crm_display_name,display_name,picture_url,last_message,last_message_at",
			id: `in.(${[targetId, ...sourceIds].map(encodeSupabaseInValue).join(",")})`,
		});
		const newest = rows.slice().sort((a: any, b: any) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime())[0] || {};
		const target = rows.find((r: any) => r.id === targetId) || {};
		const named = rows.find((r: any) => r.crm_display_name || r.display_name) || target;
		await supabasePatch(env, "line_threads", {
			crm_display_name: target.crm_display_name || named.crm_display_name || named.display_name || null,
			picture_url: target.picture_url || named.picture_url || null,
			last_message: newest.last_message || null,
			last_message_at: newest.last_message_at || now,
			merged_thread_ids: sourceIds,
			updated_at: now,
		}, { id: `eq.${targetId}` });
		for (const sourceId of sourceIds) await supabaseDelete(env, "line_threads", { id: `eq.${sourceId}` });
		return json({ ok: true, targetId, merged: sourceIds.length });
	}

	return json({ ok: false, error: "not_found" }, 404);
}

async function saveLineEvent(env: AppEnv, event: LineEvent) {
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
	const now = new Date().toISOString();

	if (hasSupabase(env)) {
		await Promise.all([
			supabaseUpsert(env, "line_threads", [{
				id: userId,
				line_user_id: userId,
				display_name: profile?.displayName || undefined,
				picture_url: profile?.pictureUrl || undefined,
				last_message: lastMessage,
				last_message_at: timestamp,
				updated_at: now,
				created_from: "line_webhook",
				source: "line_webhook",
			}]),
			supabaseUpsert(env, "line_messages", [toSupabaseMessage({
				id: messageId,
				threadId: userId,
				lineUserId: userId,
				lineMessageId: messageId,
				direction: "in",
				eventType: event.type,
				type: messageType,
				text,
				mediaUrl: media?.dataUrl,
				mediaContentType: media?.contentType,
				mediaTooLarge: !!media?.tooLarge,
				stickerPackageId: event.message?.packageId,
				stickerId: event.message?.stickerId,
				timestamp,
			})]),
		]);
		return;
	}

	await Promise.all([
		writeFirestoreDocument(env, `lineThreads/${userId}`, {
			lineUserId: stringValue(userId),
			lastMessage: stringValue(lastMessage),
			lastMessageAt: timestampValue(timestamp),
			updatedAt: timestampValue(now),
			createdFrom: stringValue("line-webhook"),
			...(profile?.displayName ? { displayName: stringValue(profile.displayName) } : {}),
			...(profile?.pictureUrl ? { pictureUrl: stringValue(profile.pictureUrl) } : {}),
		}),
		writeFirestoreDocument(env, `lineThreads/${userId}/messages/${messageId}`, {
			direction: stringValue("in"),
			lineUserId: stringValue(userId),
			lineMessageId: stringValue(messageId),
			eventType: stringValue(event.type),
			type: stringValue(messageType),
			text: stringValue(text),
			timestamp: timestampValue(timestamp),
			createdAt: timestampValue(now),
			...(media?.dataUrl ? { mediaUrl: stringValue(media.dataUrl) } : {}),
			...(media?.contentType ? { mediaContentType: stringValue(media.contentType) } : {}),
			...(media?.tooLarge ? { mediaTooLarge: booleanValue(true) } : {}),
			...(event.message?.packageId ? { stickerPackageId: stringValue(event.message.packageId) } : {}),
			...(event.message?.stickerId ? { stickerId: stringValue(event.message.stickerId) } : {}),
		}),
	]);
}

function getMessageLabel(message: LineEvent["message"]) {
	if (!message) return "[event]";
	if (message.type === "sticker") return "[sticker]";
	if (message.type === "image") return "[image]";
	if (message.type === "video") return "[video]";
	if (message.type === "audio") return "[audio]";
	if (message.type === "file") return "[file]";
	if (message.type === "location") return "[location]";
	return `[${message.type || "message"}]`;
}

function toSupabaseMessage(message: LineMessageInput & { threadId: string }) {
	const timestamp = toIso(message.timestamp) || new Date().toISOString();
	return stripUndefined({
		id: message.id || message.lineMessageId || `msg_${lineHash(JSON.stringify(message))}`,
		thread_id: message.threadId,
		line_user_id: message.lineUserId || null,
		line_message_id: message.lineMessageId || null,
		direction: message.direction || "in",
		event_type: message.eventType || null,
		type: message.type || "text",
		text: message.text || "",
		media_url: message.mediaUrl || null,
		media_content_type: message.mediaContentType || null,
		media_too_large: !!message.mediaTooLarge,
		sticker_package_id: message.stickerPackageId || null,
		sticker_id: message.stickerId || null,
		sender_type: message.senderType || null,
		sender_name: message.senderName || null,
		imported_from: message.importedFrom || null,
		merged_from: message.mergedFrom || null,
		timestamp,
		created_at: timestamp,
		imported_at: toIso(message.importedAt) || null,
		merged_at: toIso(message.mergedAt) || null,
	});
}

function messagePreview(message: LineMessageInput | undefined) {
	if (!message) return "[imported message]";
	if (message.text) return message.text;
	if (message.mediaTooLarge) return "[image too large]";
	if (message.mediaUrl) return "[image]";
	if (message.type === "sticker") return "[sticker]";
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
	if (!response.ok) return { label: "[image]" };
	const contentType = response.headers.get("content-type") || "image/jpeg";
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > 700000) return { label: "[image too large]", contentType, tooLarge: true };
	return { label: "[image]", contentType, dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}` };
}

async function requireStaff(request: Request, env: AppEnv): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const token = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) return { ok: false, status: 401, error: "missing_auth_token" };
	if (!env.FIREBASE_WEB_API_KEY) return { ok: false, status: 500, error: "missing_firebase_web_api_key" };

	const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ idToken: token }),
	});
	if (!response.ok) return { ok: false, status: 401, error: "invalid_auth_token" };
	const data = (await response.json()) as { users?: Array<{ email?: string; emailVerified?: boolean }> };
	const user = data.users?.[0];
	const email = String(user?.email || "").trim().toLowerCase();
	if (!email || !user?.emailVerified) return { ok: false, status: 403, error: "email_not_verified" };
	if (ownerEmails(env).includes(email)) return { ok: true };

	const staff = await readFirestoreDocument(env, `staff/${email}`).catch(() => null);
	if (staff && staff.fields?.active?.booleanValue !== false) return { ok: true };
	return { ok: false, status: 403, error: "not_staff" };
}

function ownerEmails(env: AppEnv) {
	return String(env.OWNER_EMAILS || "9lengleng@gmail.com,fxrnxx.lalita@gmail.com")
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
}

async function readFirestoreDocument(env: AppEnv, documentPath: string) {
	const token = await getGoogleAccessToken(env);
	const response = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${documentPath}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`Firestore read failed: ${response.status}`);
	return (await response.json()) as { fields?: Record<string, { booleanValue?: boolean }> };
}

function hasSupabase(env: AppEnv) {
	return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseSelect(env: AppEnv, table: string, params: Record<string, string>) {
	const response = await supabaseFetch(env, table, { method: "GET", params });
	if (!response.ok) throw new Error(`Supabase select failed: ${response.status} ${await response.text()}`);
	return response.json();
}

async function supabaseUpsert(env: AppEnv, table: string, rows: Array<Record<string, unknown>>) {
	for (let i = 0; i < rows.length; i += 100) {
		const response = await supabaseFetch(env, table, {
			method: "POST",
			params: { on_conflict: "id" },
			headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
			body: JSON.stringify(rows.slice(i, i + 100).map(stripUndefined)),
		});
		if (!response.ok) throw new Error(`Supabase upsert failed: ${response.status} ${await response.text()}`);
	}
}

async function supabasePatch(env: AppEnv, table: string, patch: Record<string, unknown>, params: Record<string, string>) {
	const response = await supabaseFetch(env, table, {
		method: "PATCH",
		params,
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify(stripUndefined(patch)),
	});
	if (!response.ok) throw new Error(`Supabase patch failed: ${response.status} ${await response.text()}`);
}

async function supabaseDelete(env: AppEnv, table: string, params: Record<string, string>) {
	const response = await supabaseFetch(env, table, {
		method: "DELETE",
		params,
		headers: { Prefer: "return=minimal" },
	});
	if (!response.ok) throw new Error(`Supabase delete failed: ${response.status} ${await response.text()}`);
}

async function supabaseFetch(
	env: AppEnv,
	table: string,
	options: { method: string; params?: Record<string, string>; headers?: Record<string, string>; body?: string },
) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase config");
	const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
	for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
	return fetch(url, {
		method: options.method,
		headers: {
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			"Content-Type": "application/json",
			...options.headers,
		},
		body: options.body,
	});
}

async function writeFirestoreDocument(env: AppEnv, documentPath: string, fields: Record<string, unknown>) {
	const token = await getGoogleAccessToken(env);
	const url = new URL(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${documentPath}`);
	for (const fieldPath of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", fieldPath);
	const response = await fetch(url, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ fields }),
	});
	if (!response.ok) throw new Error(`Firestore write failed: ${response.status} ${await response.text()}`);
}

async function getGoogleAccessToken(env: AppEnv) {
	const now = Math.floor(Date.now() / 1000);
	if (cachedGoogleToken && cachedGoogleToken.expiresAt - 60 > now) return cachedGoogleToken.token;
	const jwt = await signGoogleJwt(env, now);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
	});
	if (!response.ok) throw new Error(`Google token failed: ${response.status} ${await response.text()}`);
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
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem: string) {
	const pem = privateKeyPem.replace(/\\n/g, "\n");
	const base64 = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
	const keyBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	return crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function isValidLineSignature(bodyText: string, signature: string, channelSecret: string) {
	if (!signature) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
	return constantTimeEqual(bytesToBase64(new Uint8Array(digest)), signature);
}

function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

function lineHash(text: string) {
	let h = 2166136261;
	for (let i = 0; i < String(text).length; i++) {
		h ^= String(text).charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

function lineSafeId(name: string) {
	return `imported_${lineHash(String(name || "line").trim().toLowerCase())}`;
}

function cleanString(value: unknown) {
	const text = String(value || "").trim();
	return text || null;
}

function toIso(value: unknown) {
	if (!value) return null;
	const date = new Date(String(value));
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampInt(value: string | null, min: number, max: number, fallback: number) {
	const n = Number.parseInt(String(value || ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function encodeSupabaseInValue(value: string) {
	return `"${String(value).replace(/"/g, '\\"')}"`;
}

function corsHeaders() {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
		"Access-Control-Allow-Headers": "Authorization,Content-Type",
		"Access-Control-Max-Age": "86400",
	};
}

function corsResponse(body: BodyInit | null, status = 200) {
	return new Response(body, { status, headers: corsHeaders() });
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
	});
}
