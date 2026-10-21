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

// link fetchers keep upstream's preview page
const FETCHER = /bot|crawl|spider|slurp|facebookexternalhit|embedly|iframely|discord|slack|telegram|whatsapp|mastodon|pleroma|misskey|akkoma|skype|linkedin|pinterest|vkshare|preview|google|bing|yandex|duckduck|curl|wget|python|go-http|okhttp/i;

const PUBLIC_USER = sql`not u.protected and not u.instance_blocked and u.status in ('active', 'restricted') and u.deactivated_at is null`;
// staff's "Visibility limited" (Fosnr) posts stay out, as they do from search
const PUBLIC_POST = sql`not p.hidden and p.community_id is null and p.notice->>'type' is distinct from 'Fosnr'`;

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

// ── X's look ───────────────────────────────────────────────────────────────

// X's own font, from the pinned client build (as account-page.ts loads it)
let chirp: { sha: string; css: string } | undefined;
async function fontFaces() {
	const [{ loadBuild }, { readCached }] = await Promise.all([import("./build"), import("./client-cache")]);
	const build = loadBuild()?.build;
	if (!build) return "";
	if (chirp?.sha === build.sha) return chirp.css;
	const main = build.scripts.find((s: string) => /\/main\.[\w.]+\.js$/.test(s));
	const text = main ? (readCached(main)?.toString("utf8") ?? "") : "";
	const dir = main ? main.slice(0, main.lastIndexOf("/")) : "";
	const css = Object.entries({ Regular: 400, Medium: 500, Bold: 700, Heavy: 800 })
		.map(([name, weight]) => {
			const file = new RegExp(`Chirp-${name}\\.[0-9a-f]+\\.woff2`).exec(text)?.[0];
			return file ? `@font-face{font-family:TwitterChirp;src:url(/abs${dir}/${file}) format("woff2");font-weight:${weight};font-display:swap}` : "";
		})
		.join("");
	chirp = { sha: build.sha, css };
	return css;
}

// outline icons on X's 24px grid
const ICON: Record<string, string> = {
	back: '<path d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/>',
	reply: '<path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 7.501 3.58 7.501 8 0 4.42-3.586 8-8.005 8h-.006L7.12 21.55l-.004-.003L5.5 22.5v-4.74C3.247 16.47 1.751 13.42 1.751 10zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 2.82 1.38 5.06 3.749 6.08V19l3.9-2.33.02-.01h2.701c3.317 0 6.004-2.69 6.004-6 0-3.31-2.436-6-5.501-6h-4.868z"/>',
	repost: '<path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/>',
	like: '<path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/>',
	views: '<path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/>',
	bookmark: '<path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"/>',
	share: '<path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/>',
	more: '<path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/>',
	location: '<path d="M12 7c-1.93 0-3.5 1.57-3.5 3.5S10.07 14 12 14s3.5-1.57 3.5-3.5S13.93 7 12 7zm0 5c-.827 0-1.5-.67-1.5-1.5S11.173 9 12 9s1.5.67 1.5 1.5S12.827 12 12 12zm0-10c-4.687 0-8.5 3.81-8.5 8.5 0 5.967 7.621 11.116 7.945 11.332l.555.37.555-.37c.324-.216 7.945-5.365 7.945-11.332C20.5 5.81 16.687 2 12 2zm0 17.77c-1.665-1.241-6.5-5.196-6.5-9.27C5.5 6.916 8.416 4 12 4s6.5 2.916 6.5 6.5c0 4.073-4.835 8.028-6.5 9.27z"/>',
	link: '<path d="M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z"/>',
	calendar: '<path d="M7 4V3h2v1h6V3h2v1h1.5C19.89 4 21 5.12 21 6.5v12c0 1.38-1.11 2.5-2.5 2.5h-13C4.12 21 3 19.88 3 18.5v-12C3 5.12 4.12 4 5.5 4H7zm0 2H5.5c-.27 0-.5.22-.5.5v12c0 .28.23.5.5.5h13c.28 0 .5-.22.5-.5v-12c0-.28-.22-.5-.5-.5H17v1h-2V6H9v1H7V6zm0 6h2v-2H7v2zm0 4h2v-2H7v2zm4-4h2v-2h-2v2zm0 4h2v-2h-2v2zm4-4h2v-2h-2v2z"/>',
	explore: '<path d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z"/>',
};
const icon = (name: string, cls = "") => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ic ${cls}">${ICON[name]}</svg>`;

// X's verified badge, in the account's colour
const BADGE = '<path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/>';
const check = (t: string | null) =>
	t ? `<svg viewBox="0 0 22 22" aria-label="Verified account" role="img" class="badge ${t === "business" ? "gold" : t.startsWith("government") ? "grey" : ""}">${BADGE}</svg>` : "";

// 1,234 · 12.3K · 1.2M, as X counts
const count = (x: number) => (x < 10_000 ? x.toLocaleString("en-US") : x < 1_000_000 ? `${(x / 1000).toFixed(x < 100_000 ? 1 : 0).replace(/\.0$/, "")}K` : `${(x / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`);

// "30m", "5h", "Oct 20", "Oct 20, 2024"; the post's own: "5:00 PM · Oct 20, 2026"
function when(d: Date, long = false) {
	const t = new Date(d);
	if (long) return `${t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} · ${t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
	const s = (Date.now() - t.getTime()) / 1000;
	if (s < 60) return `${Math.max(1, Math.round(s))}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return t.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(t.getUTCFullYear() !== new Date().getUTCFullYear() ? { year: "numeric" } : {}), timeZone: "UTC" });
}

// links, @mentions and #hashtags in a post's text, the rest escaped
function richText(text: string) {
	return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(^|[^\w&])@(\w{1,50}(?:@[a-z0-9.-]+\.[a-z]{2,})?)|(^|[^\w&])#([\p{L}\p{N}_]{1,100})/gu, (m, url, b1, handle, b2, tag) => {
		if (url) {
			const shown = url.replace(/^https?:\/\/(www\.)?/, "");
			return `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${shown.length > 30 ? `${shown.slice(0, 29)}…` : shown}</a>`;
		}
		if (handle) return `${b1}<a href="/${handle}">@${handle}</a>`;
		return `${b2}<a href="/?app=login">#${tag}</a>`;
	});
}

// X's grey default avatar when there's no picture
const DEFAULT_AVATAR = "/abs/sticky/default_profile_images/default_profile_normal.png";
function avatar(u: { avatar_url: string | null }, size: number) {
	const id = mediaId(u.avatar_url);
	return `<img class="av" src="${id ? `/p/media/${id}` : DEFAULT_AVATAR}" alt="" width="${size}" height="${size}" loading="lazy">`;
}

function mediaGrid(r: Row) {
	if (r.sensitive && r.media.length) return `<div class="warn"><b>Content warning</b><span>The author marked this post as showing sensitive content.</span><a class="pill" href="/?app=login">Show</a></div>`;
	if (!r.media.length) return "";
	const one = r.media.length === 1 ? r.media[0] : undefined;
	return `<div class="media m${Math.min(r.media.length, 4)}"${one?.width && one.height ? ` style="aspect-ratio:${Math.max(0.75, Math.min(16 / 9, one.width / one.height))}"` : ""}>${r.media
		.slice(0, 4)
		.map((m) =>
			m.kind === "photo"
				? `<a href="/p/media/${m.id}" target="_blank"><img src="/p/media/${m.id}" alt="Image" loading="lazy"></a>`
				: `<video src="/p/media/${m.id}" poster="/p/media/${m.id}/poster.jpg" controls preload="none" playsinline></video>`,
		)
		.join("")}</div>`;
}

const actions = (r: Row, big: boolean) => `<div class="actions${big ? " big" : ""}" role="group">
	<a class="act reply" href="/?app=login" title="Reply">${icon("reply")}<span>${r.replies && !big ? count(r.replies) : ""}</span></a>
	<a class="act repost" href="/?app=login" title="Repost">${icon("repost")}<span>${r.reposts && !big ? count(r.reposts) : ""}</span></a>
	<a class="act like" href="/?app=login" title="Like">${icon("like")}<span>${r.likes && !big ? count(r.likes) : ""}</span></a>
	${big ? "" : `<span class="act views" title="View">${icon("views")}</span>`}
	<span class="end"><a class="act" href="/?app=login" title="Bookmark">${icon("bookmark")}</a><a class="act" href="/?app=login" title="Share">${icon("share")}</a></span>
</div>`;

// a post in a list: a timeline, the replies under a post
function cell(r: Row, line = false) {
	const href = `/${esc(r.screen_name)}/status/${r.id}`;
	return `<article class="cell${line ? " thread" : ""}" data-href="${href}">
	<div class="side"><a href="/${esc(r.screen_name)}">${avatar(r, 40)}</a>${line ? '<div class="line"></div>' : ""}</div>
	<div class="main">
		<div class="head"><a class="name" href="/${esc(r.screen_name)}"><b>${esc(r.name || r.screen_name)}</b>${check(r.verified_type)}</a><a class="dim" href="/${esc(r.screen_name)}">@${esc(r.screen_name)}</a><span class="dim">·</span><a class="dim" href="${href}"><time datetime="${new Date(r.created_at).toISOString()}" title="${esc(when(r.created_at, true))}">${esc(when(r.created_at))}</time></a><a class="act more" href="/?app=login" title="More">${icon("more")}</a></div>
		${r.text ? `<div class="text">${richText(r.text)}</div>` : ""}
		${mediaGrid(r)}
		${actions(r, false)}
	</div>
</article>`;
}

// the post a page is about, bigger
function focus(r: Row, parent: boolean) {
	const stats = [[r.reposts, "Repost", "Reposts"], [r.likes, "Like", "Likes"]].filter(([x]) => x) as [number, string, string][];
	return `<article class="focus${parent ? " after" : ""}">
	<div class="head"><a href="/${esc(r.screen_name)}">${avatar(r, 40)}</a><div class="who"><a class="name" href="/${esc(r.screen_name)}"><b>${esc(r.name || r.screen_name)}</b>${check(r.verified_type)}</a><a class="dim" href="/${esc(r.screen_name)}">@${esc(r.screen_name)}</a></div><a class="act more" href="/?app=login" title="More">${icon("more")}</a></div>
	${r.text ? `<div class="text">${richText(r.text)}</div>` : ""}
	${mediaGrid(r)}
	<div class="time dim"><time datetime="${new Date(r.created_at).toISOString()}">${esc(when(r.created_at, true))}</time></div>
	${stats.length ? `<div class="stats">${stats.map(([x, one, many]) => `<span><b>${count(x)}</b> ${x === 1 ? one : many}</span>`).join("")}</div>` : ""}
	${actions(r, true)}
</article>`;
}

async function shell(o: { path: string; title: string; header: string; description: string; image?: string; body: string }) {
	const s = settings();
	const name = s.instance_name;
	const closed = s.signup_mode === "closed";
	const url = PUBLIC_ORIGIN + o.path;
	const fonts = await fontFaces();
	const signup = closed ? "" : `<a class="btn primary" href="/?app=signup">Create account</a>`;
	const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
${o.image ? `<meta property="og:image" content="${esc(PUBLIC_ORIGIN + o.image)}">` : ""}
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	${fonts}
	:root { --bg: #000; --bg-hover: rgba(231,233,234,.03); --fg: #e7e9ea; --dim: #71767b; --line: #2f3336; --panel: #16181c; --input: #202327; --blue: #1d9bf0; --bar: rgba(0,0,0,.65); color-scheme: dark; }
	@media (prefers-color-scheme: light) { :root { --bg: #fff; --bg-hover: rgba(15,20,25,.03); --fg: #0f1419; --dim: #536471; --line: #eff3f4; --panel: #f7f9f9; --input: #eff3f4; --bar: rgba(255,255,255,.85); color-scheme: light; } }
	* { box-sizing: border-box; }
	html { -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/20px TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow-wrap: break-word; }
	a { color: inherit; text-decoration: none; }
	.ic { width: 18.75px; height: 18.75px; fill: currentColor; flex: none; }
	.dim { color: var(--dim); }
	.layout { display: flex; justify-content: center; min-height: 100vh; }
	/* left: the instance's mark and Explore, like X signed out */
	.left { width: 275px; display: flex; justify-content: flex-end; }
	.left nav { position: sticky; top: 0; height: 100vh; width: 259px; padding: 2px 12px 0 8px; display: flex; flex-direction: column; }
	.left .mark { display: inline-flex; width: 52px; height: 52px; margin: 2px 0 4px; border-radius: 50%; align-items: center; justify-content: center; }
	.left .mark:hover, .left .item:hover { background: rgba(231,233,234,.1); }
	.left .mark img { width: 30px; height: 30px; object-fit: contain; }
	.left .item { display: inline-flex; align-items: center; gap: 20px; width: max-content; padding: 12px; border-radius: 999px; font-size: 20px; line-height: 24px; }
	.left .item .ic { width: 26.25px; height: 26.25px; }
	/* middle: the column */
	.col { width: 600px; min-width: 0; border-left: 1px solid var(--line); border-right: 1px solid var(--line); padding-bottom: 80px; }
	.bar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 24px; height: 53px; padding: 0 16px; background: var(--bar); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
	.bar .back { display: grid; place-items: center; width: 34px; height: 34px; margin-left: -6px; border-radius: 50%; }
	.bar .back:hover { background: rgba(231,233,234,.1); }
	.bar .back .ic { width: 20px; height: 20px; }
	.bar h2 { margin: 0; font-size: 20px; line-height: 24px; font-weight: 700; }
	.bar small { display: block; color: var(--dim); font-size: 13px; line-height: 16px; font-weight: 400; }
	/* posts */
	.cell { display: flex; gap: 8px; padding: 12px 16px 0; border-bottom: 1px solid var(--line); cursor: pointer; transition: background .2s; }
	.cell:hover { background: var(--bg-hover); }
	.cell.thread { border-bottom: 0; }
	.side { display: flex; flex-direction: column; align-items: center; flex: none; width: 40px; }
	.line { width: 2px; flex: 1; margin-top: 4px; background: var(--line); }
	.av { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; display: block; background: var(--panel); }
	.main { flex: 1; min-width: 0; padding-bottom: 12px; }
	.head { display: flex; align-items: center; gap: 4px; min-width: 0; white-space: nowrap; }
	.head .name { display: inline-flex; align-items: center; min-width: 0; overflow: hidden; }
	.head .name b { overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
	.head .name:hover b { text-decoration: underline; }
	.head .dim { overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 40%; }
	.head time:hover { text-decoration: underline; }
	.badge { width: 18.75px; height: 18.75px; margin-left: 2px; fill: var(--blue); flex: none; }
	.badge.gold { fill: #e2b719; } .badge.grey { fill: #829aab; }
	.more { margin-left: auto; }
	.text { white-space: pre-wrap; margin-top: 2px; }
	.text a { color: var(--blue); }
	.text a:hover { text-decoration: underline; }
	.media { display: grid; gap: 2px; margin-top: 12px; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; max-height: 510px; }
	.media.m1 > * { height: 100%; }
	.media.m2, .media.m3, .media.m4 { grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; }
	.media.m3 > :first-child { grid-row: span 2; }
	.media img, .media video { display: block; width: 100%; height: 100%; object-fit: cover; background: var(--panel); }
	.warn { margin-top: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 16px; display: grid; gap: 4px; }
	.warn span { color: var(--dim); }
	.pill { justify-self: start; margin-top: 8px; padding: 6px 16px; border-radius: 999px; border: 1px solid #536471; font-weight: 700; }
	.actions { display: flex; align-items: center; justify-content: space-between; max-width: 425px; margin: 12px 0 0 -8px; color: var(--dim); }
	.actions .end { display: flex; }
	.act { display: inline-flex; align-items: center; gap: 2px; min-width: 34px; height: 34px; padding: 0 8px; border-radius: 999px; font-size: 13px; line-height: 16px; color: var(--dim); transition: color .2s, background .2s; }
	.act span:empty { display: none; }
	.reply:hover { color: var(--blue); background: rgba(29,155,240,.1); }
	.repost:hover { color: #00ba7c; background: rgba(0,186,124,.1); }
	.like:hover { color: #f91880; background: rgba(249,24,128,.1); }
	.end .act:hover, .more:hover { color: var(--blue); background: rgba(29,155,240,.1); }
	.focus { padding: 12px 16px 0; border-bottom: 1px solid var(--line); }
	.focus.after { padding-top: 4px; }
	.focus .head { gap: 8px; }
	.focus .who { display: flex; flex-direction: column; min-width: 0; line-height: 20px; }
	.focus .who .dim, .focus .who .name { max-width: none; }
	.focus .text { font-size: 17px; line-height: 24px; margin-top: 12px; }
	.focus .time { padding: 16px 0; }
	.stats { display: flex; gap: 20px; padding: 16px 4px; border-top: 1px solid var(--line); color: var(--dim); }
	.stats b { color: var(--fg); font-weight: 700; }
	.actions.big { max-width: none; margin: 0; padding: 4px 0; border-top: 1px solid var(--line); }
	.actions.big .ic { width: 22.5px; height: 22.5px; }
	.prompt { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 20px; }
	.prompt .btn { margin-left: auto; font-size: 15px; }
	/* profile */
	.banner { aspect-ratio: 3 / 1; background: #333639 center / cover no-repeat; }
	.prof { padding: 12px 16px 0; }
	.prof .top { display: flex; justify-content: space-between; align-items: flex-start; height: 72px; }
	.prof .av { width: 133.5px; height: 133.5px; margin-top: -80px; border: 4px solid var(--bg); }
	.prof h1 { margin: 4px 0 0; font-size: 20px; line-height: 24px; font-weight: 800; display: flex; align-items: center; }
	.prof h1 .badge { width: 20px; height: 20px; }
	.prof .bio { margin-top: 12px; white-space: pre-wrap; }
	.prof .bio a, .prof .facts a { color: var(--blue); }
	.prof .facts { display: flex; flex-wrap: wrap; gap: 0 12px; margin-top: 12px; color: var(--dim); }
	.prof .facts span { display: inline-flex; align-items: center; gap: 4px; }
	.prof .follow { display: flex; gap: 20px; margin-top: 12px; color: var(--dim); }
	.prof .follow b { color: var(--fg); font-weight: 700; }
	.tabs { display: flex; border-bottom: 1px solid var(--line); margin-top: 16px; }
	.tabs a { flex: 1; display: flex; justify-content: center; color: var(--dim); font-weight: 500; }
	.tabs a:hover { background: rgba(231,233,234,.1); }
	.tabs a span { padding: 16px 0; position: relative; }
	.tabs a.on { color: var(--fg); font-weight: 700; }
	.tabs a.on span::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; border-radius: 999px; background: var(--blue); }
	.empty { padding: 32px; color: var(--dim); text-align: center; }
	/* right: sign up, like X signed out */
	.right { width: 350px; margin-left: 30px; }
	.right .stick { position: sticky; top: 0; padding-top: 12px; }
	.box { border: 1px solid var(--line); border-radius: 16px; padding: 12px 16px 16px; }
	.box h2 { margin: 0 0 8px; font-size: 20px; line-height: 24px; font-weight: 800; }
	.box p { margin: 0 0 16px; color: var(--dim); font-size: 13px; line-height: 16px; }
	.box .btn { display: flex; justify-content: center; margin-top: 8px; }
	.foot { padding: 12px 16px; color: var(--dim); font-size: 13px; line-height: 16px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
	.foot a:hover { text-decoration: underline; }
	.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 16px; border-radius: 999px; font-weight: 700; border: 1px solid #536471; white-space: nowrap; }
	.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
	.btn.blue { background: var(--blue); border-color: var(--blue); color: #fff; }
	/* the bar along the bottom */
	.join { position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; background: var(--blue); color: #fff; }
	.join .in { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 72px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
	.join .words { width: 600px; margin-left: 275px; }
	.join b { display: block; font-size: 23px; line-height: 28px; font-weight: 700; }
	.join small { font-size: 15px; }
	.join .btn { border-color: rgba(255,255,255,.35); color: #fff; }
	.join .btn.primary { background: #fff; color: #0f1419; border-color: #fff; }
	@media (max-width: 1280px) { .left { width: 88px; } .left nav { width: 88px; align-items: center; padding: 2px 0 0; } .left .item span { display: none; } .join .words { margin-left: 88px; } }
	@media (max-width: 1080px) { .right { display: none; } .join .words { margin-left: 0; width: auto; } }
	@media (max-width: 700px) {
		.left { display: none; }
		.col { border: 0; width: 100%; }
		.join .words { display: none; }
		.join .in { min-height: 0; justify-content: stretch; }
		.join .btn { flex: 1; min-height: 40px; }
	}
</style>
</head>
<body>
<div class="layout">
	<header class="left"><nav>
		<a class="mark" href="/" title="${esc(name)}"><img src="/public/icon-dark.png" alt="${esc(name)}"></a>
		<a class="item" href="/?app=login">${icon("explore")}<span>Explore</span></a>
	</nav></header>
	<main class="col">
		<div class="bar"><a class="back" href="/" title="Back">${icon("back")}</a><h2>${o.header}</h2></div>
		${o.body}
	</main>
	<aside class="right"><div class="stick">
		<div class="box"><h2>New to ${esc(name)}?</h2><p>Sign up now to get your own personalized timeline!</p>${signup}<a class="btn" href="/?app=login">Sign in</a></div>
		<div class="foot"><a href="/rules">Rules</a>${extras().stats.enabled ? '<a href="/stats">Stats</a>' : ""}<a href="${esc(s.source_url)}">Source</a><span>© ${new Date().getUTCFullYear()} ${esc(name)}</span></div>
	</div></aside>
</div>
<div class="join"><div class="in">
	<div class="words"><b>Don’t miss what’s happening</b><small>People on ${esc(name)} are the first to know.</small></div>
	<a class="btn" href="/?app=login">Log in</a>${closed ? "" : `<a class="btn primary" href="/?app=signup">Sign up</a>`}
</div></div>
<script>
// a post opens from anywhere on it, as on X, but its links still go where they point
document.addEventListener("click", function (e) {
	var cell = e.target.closest("[data-href]");
	if (!cell || e.target.closest("a, video, button")) return;
	if (getSelection().toString()) return;
	location.href = cell.dataset.href;
});
</script>
</body>
</html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ── the pages ──────────────────────────────────────────────────────────────

const clipText = (t: string, max: number) => ([...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t);

// by id alone: a link from before a handle change still finds the post
async function postPage(id: string): Promise<Response | undefined> {
	const [post] = await posts(sql`p.id = ${id}::bigint`, sql`p.id`, 1);
	if (!post) return undefined;
	const [parent] = post.reply_to_id ? await posts(sql`p.id = ${post.reply_to_id}::bigint`, sql`p.id`, 1) : [];
	const replies = await posts(sql`p.reply_to_id = ${id}::bigint`, sql`p.id`, 30);
	const first = post.media.find((m) => m.kind === "photo");
	const name = settings().instance_name;
	return shell({
		path: `/${post.screen_name}/status/${post.id}`,
		// X's own form: Name on X: "text" / X
		title: `${post.name || post.screen_name} on ${name}: "${clipText(post.text, 120)}" / ${name}`,
		header: "Post",
		description: clipText(post.text, 300),
		image: !post.sensitive && first ? `/p/media/${first.id}` : undefined,
		body: `${parent ? cell(parent, true) : ""}${focus(post, !!parent)}
		<div class="prompt">${avatar({ avatar_url: null }, 40)}<span>Post your reply</span><a class="btn blue" href="/?app=login">Reply</a></div>
		${replies.map((r) => cell(r)).join("")}`,
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
	const name = settings().instance_name;
	return shell({
		path: `/${u.screen_name}`,
		title: `${u.name || u.screen_name} (@${u.screen_name}) / ${name}`,
		header: `${esc(u.name || u.screen_name)}<small>${count(u.posts)} ${u.posts === 1 ? "post" : "posts"}</small>`,
		description: u.bio || `@${u.screen_name}`,
		image: mediaId(u.avatar_url) ? `/p/media/${mediaId(u.avatar_url)}` : undefined,
		body: `<div class="banner"${banner ? ` style="background-image:url(/p/media/${banner})"` : ""}></div>
<div class="prof">
	<div class="top">${avatar(u, 134)}<a class="btn primary" href="/?app=login">Follow</a></div>
	<h1>${esc(u.name || u.screen_name)}${check(u.verified_type)}</h1>
	<div class="dim">@${esc(u.screen_name)}</div>
	${u.bio ? `<div class="bio">${richText(u.bio)}</div>` : ""}
	<div class="facts">${u.location ? `<span>${icon("location")}${esc(u.location)}</span>` : ""}${site ? `<span>${icon("link")}<a href="${esc(site)}" rel="nofollow ugc noopener me" target="_blank">${esc(site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 40))}</a></span>` : ""}<span>${icon("calendar")}Joined ${esc(new Date(u.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }))}</span></div>
	<div class="follow"><a href="/?app=login"><b>${count(u.following)}</b> Following</a><a href="/?app=login"><b>${count(u.followers)}</b> ${u.followers === 1 ? "Follower" : "Followers"}</a></div>
</div>
<nav class="tabs"><a class="on" href="/${esc(u.screen_name)}"><span>Posts</span></a><a href="/?app=login"><span>Replies</span></a><a href="/?app=login"><span>Media</span></a></nav>
${list.length ? list.map((r) => cell(r)).join("") : `<div class="empty"><b>@${esc(u.screen_name)} hasn’t posted</b><br>When they do, their posts will show up here.</div>`}`,
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
	// a limit per address: the pages run a few counting queries each (the
	// endpoint bucket, 1000 a quarter hour); their pictures, several a page,
	// only a lookup each (the read bucket, 6000)
	const [{ hit, limitedResponse }, { requestIp }] = await Promise.all([import("./ratelimit"), import("./login-history")]);
	const ip = requestIp(req) ?? "unknown";
	if (file) {
		const h = hit("read", `public-media:${ip}`);
		return h.ok ? mediaFile(req, file[1], !!file[2]) : limitedResponse(h);
	}
	if (FETCHER.test(req.headers.get("user-agent") ?? "")) return undefined;
	const h = hit("endpoint", `public-page:${ip}`);
	if (!h.ok) return limitedResponse(h);
	const status = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d{1,19})(?:\/(?:photo|video)\/\d)?\/?$/.exec(p);
	if (status) return isId(status[2]) ? postPage(status[2]) : undefined;
	const profile = /^\/([A-Za-z0-9_]{1,50})\/?(?:with_replies|media)?\/?$/.exec(p)?.[1];
	if (profile && !RESERVED.has(profile.toLowerCase())) return profilePage(profile);
	return undefined;
}
