/**
 * pi-agent-push — ntfy channel (https://ntfy.sh / self-hosted).
 *
 * Body is plain text only (`message` / payload.text). No JSON envelope.
 * Optional priority / tags / click / icon go as HTTP headers so they do not
 * pollute the notification body.
 *
 * The message title goes in the `Title` header too. HTTP header values are
 * ByteStrings, so a non-ASCII title (any Chinese one, for instance) throws in
 * `fetch` unless it is encoded first — ntfy documents RFC 2047 for exactly
 * this case, and decodes `=?UTF-8?B?...?=` back into the original text.
 */

import { httpRequest, localFailure, type HttpResult } from "../http.ts";
import type { NotifyPayload, NtfyChannel } from "../types.ts";

const DEFAULT_SERVER = "https://ntfy.sh";

const NON_ASCII = /[^\x20-\x7e]/;
// Header folding: collapse CR/LF/TAB and every other control char to one space,
// so a value taken from config can never start a second header line.
const UNSAFE_HEADER_CHARS = /[\u0000-\u001f\u007f]+/g;

/**
 * Make `value` safe to hand to `Headers`. ntfy accepts either plain UTF-8
 * (only if the client can send it) or the RFC 2047 encoded-word form, so we
 * keep ASCII alone and encode anything else.
 */
export function ntfyHeaderValue(value: string): string {
	const cleaned = value.replace(UNSAFE_HEADER_CHARS, " ").trim();
	if (!cleaned) return "";
	if (!NON_ASCII.test(cleaned)) return cleaned;
	return `=?UTF-8?B?${Buffer.from(cleaned, "utf-8").toString("base64")}?=`;
}

export async function sendNtfy(
	channel: NtfyChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const topic = (channel.topic ?? "").trim();
	if (!topic) return localFailure("ntfy: topic 为空");

	const server = (channel.server ?? DEFAULT_SERVER).trim().replace(/\/+$/, "");
	const headers: Record<string, string> = {
		"Content-Type": "text/plain; charset=utf-8",
	};

	const token = (channel.token ?? "").trim();
	if (token) {
		headers.Authorization = token.toLowerCase().startsWith("bearer ")
			? token
			: `Bearer ${token}`;
	}

	// Metadata via headers only — body stays pure message text.
	const title = ntfyHeaderValue(payload.title ?? "");
	// An empty title would make ntfy fall back to the topic name; skipping the
	// header keeps that behaviour rather than sending a blank one.
	if (title) headers.Title = title;
	if (channel.priority != null && channel.priority !== "") {
		headers.Priority = String(channel.priority);
	}
	if (channel.tags != null) {
		// Encoded per tag: one encoded-word for the whole list would decode back
		// into a single tag containing the commas.
		const tags = (Array.isArray(channel.tags) ? channel.tags : [String(channel.tags)])
			.map((tag) => ntfyHeaderValue(tag))
			.filter((tag) => tag.length > 0);
		if (tags.length > 0) headers.Tags = tags.join(",");
	}
	const clickUrl = ntfyHeaderValue(channel.clickUrl ?? "");
	if (clickUrl) headers.Click = clickUrl;
	const icon = ntfyHeaderValue(channel.icon ?? "");
	if (icon) headers.Icon = icon;
	const email = ntfyHeaderValue(channel.email ?? "");
	if (email) headers.Email = email;

	const url = `${server}/${encodeURIComponent(topic)}`;
	const body = payload.text;

	const result = await httpRequest(
		url,
		{ method: "POST", headers, body },
		timeoutMs,
	);

	if (!result.ok) {
		let detail = result.error ?? `HTTP ${result.status}`;
		if (result.body) {
			try {
				const data = JSON.parse(result.body) as { error?: string; message?: string };
				detail = data.error || data.message || detail;
			} catch {
				detail = result.body.slice(0, 200) || detail;
			}
		}
		return { ...result, error: `ntfy ${detail}` };
	}
	return result;
}
