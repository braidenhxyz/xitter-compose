// This instance only, not upstream: someone signed out who opens a shared link
// to a post or a profile reads it here, on a plain page, instead of being sent
// to the sign-in page. Link fetchers (Discord, iMessage…) still get upstream's
// preview page (embeds.ts linkPreview), which these pages also carry the tags of.
//
// The same accounts and posts as those previews: active or restricted,
// unprotected, not deactivated or blocked accounts, and posts that aren't
// hidden or in a community. A sensitive post shows no media. Their photos and
// videos are served at /p/media/<id>; everything else stays for signed-in
// accounts. Admin > Instance extras turns it off. Pages ask search engines not
// to index them.

import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId } from "./ids";
import { extras } from "./instance-extras";
import { settings } from "./settings";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (x: number) => x.toLocaleString("en-US");

// link fetchers keep upstream's preview page
const FETCHER = /bot|crawl|spider|slurp|facebookexternalhit|embedly|iframely|discord|slack|telegram|whatsapp|mastodon|pleroma|misskey|akkoma|skype|linkedin|pinterest|vkshare|preview|google|bing|yandex|duckduck|curl|wget|python|go-http|okhttp/i;

const PUBLIC_USER = sql`not u.protected and not u.instance_blocked and u.status in ('active', 'restricted') and u.deactivated_at is null`;
const PUBLIC_POST = sql`not p.hidden and p.community_id is null`;

type Media = { id: string; kind: string; width: number; height: number };
type Row = { id: string; text: string; created_at: Date; sensitive: boolean; reply_to_id: string | null; likes: number; reposts: number; replies: number;
	user_id: string; screen_name: string; name: string; avatar_url: string | null; verified_type: string | null; media: Media[] };

const postCols = sql`p.id::text, p.text, p.created_at, p.sensitive and not u.never_sensitive as sensitive, p.reply_to_id::text,
	(select count(*)::int from likes x where x.post_id = p.id) as likes, (select count(*)::int from reposts x where x.post_id = p.id) as reposts,
	(select count(*)::int from posts x where x.reply_to_id = p.id and not x.hidden) as replies,
	u.id::text as user_id, u.screen_name, u.name, u.avatar_url, u.verified_type,
	coalesce((select json_agg(json_build_object('id', m.id::text, 'kind', m.kind, 'width', m.width, 'height', m.height) order by m.position nulls last)
		from media m where m.post_id = p.id and m.state = 'ready' and (coalesce(cardinality(m.sensitive_warning), 0) = 0 or u.never_sensitive)), '[]') as media`;

const posts = (where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number) =>
	sql`select ${postCols} from posts p join users u on u.id = p.user_id where ${where} and ${PUBLIC_POST} and ${PUBLIC_USER} order by ${order} limit ${limit}` as unknown as Promise<Row[]>;

const mediaId = (url: string | null) => /^\/media\/(?:banner\/)?(\d{1,19})$/.exec(url ?? "")?.[1];

// ── pieces ─────────────────────────────────────────────────────────────────

function when(d: Date, long = false) {
	const t = new Date(d);
	if (long) return t.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + " UTC";
	const s = (Date.now() - t.getTime()) / 1000;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return t.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(s > 300 * 86400 ? { year: "numeric" } : {}), timeZone: "UTC" });
}

// links, @mentions and #hashtags in a post's text, the rest escaped
function richText(text: string) {
	return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(^|[^\w&])@(\w{1,50}(?:@[a-z0-9.-]+\.[a-z]{2,})?)|(^|[^\w&])#([\p{L}\p{N}_]{1,100})/gu, (m, url, b1, handle, b2, tag) => {
		if (url) return `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${url.replace(/^https?:\/\//, "").slice(0, 60)}${url.length > 68 ? "…" : ""}</a>`;
		if (handle) return `${b1}<a href="/${handle}">@${handle}</a>`;
		return `${b2}<span class="tag">#${tag}</span>`;
	});
}

const hue = (h: string) => [...h].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
function avatar(u: { screen_name: string; name: string; avatar_url: string | null }, size = 40) {
	const id = mediaId(u.avatar_url);
	return id
		? `<img class="av" src="/p/media/${id}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px" loading="lazy">`
		: `<span class="av" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:hsl(${hue(u.screen_name)} 55% 42%)">${esc([...(u.name || u.screen_name)][0]?.toUpperCase() ?? "?")}</span>`;
}

const check = (t: string | null) => (t ? `<span class="check ${t === "business" ? "gold" : t.startsWith("government") ? "grey" : ""}" title="Verified">✓</span>` : "");

function mediaGrid(r: Row) {
	if (r.sensitive && r.media.length) return `<div class="sensitive">This post has media marked sensitive. Sign in to see it.</div>`;
	if (!r.media.length) return "";
	return `<div class="media m${Math.min(r.media.length, 4)}">${r.media
		.slice(0, 4)
		.map((m) =>
			m.kind === "photo"
				? `<a href="/p/media/${m.id}" target="_blank"><img src="/p/media/${m.id}" alt="" loading="lazy"${m.width && m.height ? ` style="aspect-ratio:${m.width}/${m.height}"` : ""}></a>`
				: `<video src="/p/media/${m.id}" poster="/p/media/${m.id}/poster.jpg" controls preload="none" playsinline${m.width && m.height ? ` style="aspect-ratio:${m.width}/${m.height}"` : ""}></video>`,
		)
		.join("")}</div>`;
}

function postCard(r: Row, big = false) {
	const href = `/${esc(r.screen_name)}/status/${r.id}`;
	return `<article class="${big ? "big" : ""}">
	<a class="avlink" href="/${esc(r.screen_name)}">${avatar(r, big ? 48 : 40)}</a>
	<div class="body">
		<div class="who"><a href="/${esc(r.screen_name)}"><b>${esc(r.name || r.screen_name)}</b>${check(r.verified_type)} <span>@${esc(r.screen_name)}</span></a>${big ? "" : ` <span>· <a href="${href}">${esc(when(r.created_at))}</a></span>`}</div>
		${r.text ? `<p class="text">${richText(r.text)}</p>` : ""}
		${mediaGrid(r)}
		${big ? `<p class="time">${esc(when(r.created_at, true))}</p>` : ""}
		<div class="counts"><span title="Replies">💬 ${n(r.replies)}</span><span title="Reposts">🔁 ${n(r.reposts)}</span><span title="Likes">♥ ${n(r.likes)}</span></div>
	</div>
</article>`;
}

function shell(o: { path: string; title: string; description: string; image?: string; body: string }) {
	const name = settings().instance_name;
	const closed = settings().signup_mode === "closed";
	const url = PUBLIC_ORIGIN + o.path;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
${o.image ? `<meta property="og:image" content="${esc(PUBLIC_ORIGIN + o.image)}">` : ""}
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	:root { --bg: #000; --fg: #e7e9ea; --dim: #71767b; --line: #2f3336; --card: #16181c; --accent: #1d9bf0; }
	@media (prefers-color-scheme: light) { :root { --bg: #fff; --fg: #0f1419; --dim: #536471; --line: #eff3f4; --card: #f7f9f9; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.4 TwitterChirp, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
	a { color: inherit; text-decoration: none; }
	.text a, .bio a, .site a { color: var(--accent); }
	.text a:hover, .who a:hover b { text-decoration: underline; }
	.top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
	.top .home { font-weight: 800; font-size: 17px; margin-right: auto; }
	.btn { padding: 7px 16px; border-radius: 999px; font-weight: 700; font-size: 14px; border: 1px solid var(--line); white-space: nowrap; }
	.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
	main { max-width: 600px; margin: 0 auto; border-left: 1px solid var(--line); border-right: 1px solid var(--line); min-height: 100vh; }
	@media (max-width: 600px) { main { border: 0; } }
	article { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	article.big { padding-top: 16px; }
	.av { border-radius: 50%; object-fit: cover; flex: none; display: grid; place-items: center; color: #fff; font-weight: 700; background: var(--card); }
	.body { min-width: 0; flex: 1; }
	.who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.who span { color: var(--dim); }
	.check { display: inline-grid; place-items: center; width: 16px; height: 16px; margin-left: 3px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 10px; font-weight: 900; vertical-align: -2px; }
	.check.gold { background: #e2b719; border-radius: 4px; } .check.grey { background: #829aab; border-radius: 4px; }
	.text { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
	.big .text { font-size: 17px; line-height: 1.35; margin-top: 8px; }
	.tag { color: var(--accent); }
	.time { color: var(--dim); margin: 12px 0 0; font-size: 14px; }
	.counts { display: flex; gap: 22px; margin-top: 10px; color: var(--dim); font-size: 13px; }
	.media { display: grid; gap: 2px; margin-top: 10px; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
	.media.m2, .media.m3, .media.m4 { grid-template-columns: 1fr 1fr; }
	.media.m3 > :first-child { grid-row: span 2; }
	.media img, .media video { display: block; width: 100%; max-height: 520px; object-fit: cover; background: var(--card); }
	.media.m2 img, .media.m3 img, .media.m4 img { height: 100%; max-height: 280px; aspect-ratio: auto !important; }
	.sensitive { margin-top: 10px; padding: 16px; border: 1px solid var(--line); border-radius: 16px; color: var(--dim); background: var(--card); }
	.section { padding: 14px 16px 10px; font-weight: 800; font-size: 17px; border-bottom: 1px solid var(--line); }
	.banner { aspect-ratio: 3 / 1; background: var(--card) center / cover no-repeat; }
	.head { padding: 12px 16px 16px; border-bottom: 1px solid var(--line); }
	.head .av { margin-top: -52px; border: 4px solid var(--bg); }
	.head h1 { margin: 10px 0 0; font-size: 20px; font-weight: 800; }
	.head .handle { color: var(--dim); }
	.bio { margin: 12px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
	.facts, .follow { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 12px; color: var(--dim); font-size: 14px; }
	.follow b { color: var(--fg); }
	.join { padding: 28px 16px; text-align: center; color: var(--dim); }
	.join .btn { display: inline-block; margin: 12px 4px 0; }
	.empty { padding: 28px 16px; color: var(--dim); text-align: center; }
</style>
</head>
<body>
<header class="top">
	<a class="home" href="/">${esc(name)}</a>
	<a class="btn" href="/?app=login">Sign in</a>
	${closed ? "" : `<a class="btn primary" href="/?app=signup">Sign up</a>`}
</header>
<main>
${o.body}
<div class="join">See more, reply and follow on ${esc(name)}.<br>
	${closed ? "" : `<a class="btn primary" href="/?app=signup">Create account</a>`}<a class="btn" href="/?app=login">Sign in</a></div>
</main>
</body>
</html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ── the pages ──────────────────────────────────────────────────────────────

// by id alone: a link from before a handle change still finds the post
async function postPage(id: string): Promise<Response | undefined> {
	const [post] = await posts(sql`p.id = ${id}::bigint`, sql`p.id`, 1);
	if (!post) return undefined;
	const [parent] = post.reply_to_id ? await posts(sql`p.id = ${post.reply_to_id}::bigint`, sql`p.id`, 1) : [];
	const replies = await posts(sql`p.reply_to_id = ${id}::bigint`, sql`p.id`, 30);
	const first = post.media.find((m) => m.kind === "photo");
	return shell({
		path: `/${post.screen_name}/status/${post.id}`,
		title: `${post.name || post.screen_name} on ${settings().instance_name}: "${[...post.text].slice(0, 80).join("")}${[...post.text].length > 80 ? "…" : ""}"`,
		description: [...post.text].slice(0, 300).join(""),
		image: !post.sensitive && first ? `/p/media/${first.id}` : undefined,
		body: `<div class="section">Post</div>${parent ? postCard(parent) : ""}${postCard(post, true)}${replies.length ? replies.map((r) => postCard(r)).join("") : ""}`,
	});
}

async function profilePage(handle: string): Promise<Response | undefined> {
	const [u] = await sql`select u.id::text, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.created_at,
			(select count(*)::int from follows f where f.followee_id = u.id) as followers, (select count(*)::int from follows f where f.follower_id = u.id) as following,
			(select count(*)::int from posts p where p.user_id = u.id and not p.hidden) as posts
		from users u where lower(u.screen_name) = lower(${handle}) and ${PUBLIC_USER}`;
	if (!u) return undefined;
	const list = await posts(sql`p.user_id = ${u.id}::bigint and p.reply_to_id is null`, sql`p.id desc`, 20);
	const banner = mediaId(u.banner_url);
	const site = u.website && /^https?:\/\//.test(u.website) ? u.website : "";
	return shell({
		path: `/${u.screen_name}`,
		title: `${u.name || u.screen_name} (@${u.screen_name}) on ${settings().instance_name}`,
		description: u.bio || `@${u.screen_name}`,
		image: mediaId(u.avatar_url) ? `/p/media/${mediaId(u.avatar_url)}` : undefined,
		body: `<div class="banner"${banner ? ` style="background-image:url(/p/media/${banner})"` : ""}></div>
<div class="head">
	${avatar(u, 96)}
	<h1>${esc(u.name || u.screen_name)}${check(u.verified_type)}</h1>
	<div class="handle">@${esc(u.screen_name)}</div>
	${u.bio ? `<p class="bio">${richText(u.bio)}</p>` : ""}
	<div class="facts">${u.location ? `<span>📍 ${esc(u.location)}</span>` : ""}${site ? `<span class="site"><a href="${esc(site)}" rel="nofollow ugc noopener me" target="_blank">🔗 ${esc(site.replace(/^https?:\/\//, "").slice(0, 40))}</a></span>` : ""}<span>📅 Joined ${esc(new Date(u.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }))}</span></div>
	<div class="follow"><span><b>${n(u.following)}</b> Following</span><span><b>${n(u.followers)}</b> Followers</span><span><b>${n(u.posts)}</b> Posts</span></div>
</div>
<div class="section">Posts</div>
${list.length ? list.map((r) => postCard(r)).join("") : `<div class="empty">@${esc(u.screen_name)} hasn't posted yet.</div>`}`,
	});
}

// a photo, video or its poster from a post these pages show, or a public
// account's avatar or banner
async function mediaFile(req: Request, id: string, poster: boolean): Promise<Response> {
	const none = new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!isId(id)) return none;
	const [m] = await sql`select m.mime, m.kind from media m
		where m.id = ${id}::bigint and m.state = 'ready' and (
			exists (select 1 from posts p join users u on u.id = p.user_id where p.id = m.post_id and ${PUBLIC_POST} and ${PUBLIC_USER}
				and not (p.sensitive and not u.never_sensitive) and (coalesce(cardinality(m.sensitive_warning), 0) = 0 or u.never_sensitive))
			or exists (select 1 from users u where (u.avatar_url = ${`/media/${id}`} or u.banner_url = ${`/media/banner/${id}`}) and ${PUBLIC_USER}))`;
	if (!m) return none;
	const { remoteMediaFile } = await import("./federation-sync");
	const body = await remoteMediaFile(id, poster);
	if (!body) return none;
	const headers: Record<string, string> = { "content-type": poster ? "image/jpeg" : m.mime, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
	// videos seek with ranges
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		const size = body.size;
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		return new Response(body.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
	}
	return new Response(body, { headers });
}

const RESERVED = new Set(["home", "explore", "notifications", "messages", "settings", "search", "i", "login", "signup", "logout", "rules", "tos", "privacy", "stats", "compose", "account", "admin", "public", "media", "embed", "oembed", "api"]);

// signed out, a GET (server.ts); undefined carries on as before
export async function publicView(req: Request, url: URL): Promise<Response | undefined> {
	const p = url.pathname;
	const file = /^\/p\/media\/(\d{1,19})(\/poster\.jpg)?$/.exec(p);
	if (!extras().public_pages.enabled) return file ? new Response("not found", { status: 404 }) : undefined;
	if (file) return mediaFile(req, file[1], !!file[2]);
	if (FETCHER.test(req.headers.get("user-agent") ?? "")) return undefined;
	const status = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d{1,19})(?:\/(?:photo|video)\/\d)?\/?$/.exec(p);
	if (status) return isId(status[2]) ? postPage(status[2]) : undefined;
	const profile = /^\/([A-Za-z0-9_]{1,50})\/?(?:with_replies|media)?\/?$/.exec(p)?.[1];
	if (profile && !RESERVED.has(profile.toLowerCase())) return profilePage(profile);
	return undefined;
}
