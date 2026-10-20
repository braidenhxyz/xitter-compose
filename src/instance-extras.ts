// This instance's own extras, kept out of upstream's files so merging upstream
// stays easy: each is hooked in with a line or two (server.ts, invites.ts,
// graphql.ts, search.ts, admin.ts, admin.html). An admin sets them in the
// admin panel, Instance extras.
//
// - Welcome: a message to each new account, shown as a card on its first
//   visit (the staff-message popup, automod-notice.ts) and kept in its Staff
//   notices. DMs are end-to-end encrypted, so the server can't send one.
// - Landing page: signed out, "/" is this instance's own page (its name, what
//   it's about, a few recent public posts, the rules) instead of X's; its
//   buttons open X's sign-in and sign-up dialogs (/?app=login, /?app=signup).
// - From this instance: the top of Explore shows the latest posts by this
//   instance's own accounts, and "Show more" searches all of them
//   ("filter:local", search.ts).
// - Owner: one admin is the instance's owner, saved here rather than worked out
//   as the longest-standing admin like upstream does (admin.ts ownerId), so
//   editing join dates can't move it. Only the owner changes join dates and
//   hands the instance to another admin (instance-extras-admin.ts).

// what pulls in half the server (posts, search, the client shell) is
// imported where it's used, so this file can load before or after any of it
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { newId } from "./ids";
import { settings } from "./settings";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type Extras = {
	welcome: { enabled: boolean; from: string; text: string };
	landing: { enabled: boolean; tagline: string; about: string; posts: boolean };
	local_explore: { enabled: boolean };
	owner: { id: string };
};

const DEFAULTS: Extras = {
	welcome: {
		enabled: true,
		from: "",
		text: "Welcome to {instance}, {name}!\n\nHave a look at the rules ({origin}/rules), say hello in a first post, and find people in Explore. Accounts from other instances show their instance after their handle.\n\nIf you need a hand, ask the staff.",
	},
	landing: { enabled: true, tagline: "", about: "", posts: true },
	local_explore: { enabled: true },
	owner: { id: "" },
};

let current: Extras = structuredClone(DEFAULTS);

// at start (server.ts): the table, and what an admin saved
export async function loadExtras() {
	await sql`create table if not exists instance_extras (key text primary key, value jsonb not null)`;
	const next = structuredClone(DEFAULTS) as any;
	for (const r of await sql`select key, value from instance_extras`) if (r.key in next) next[r.key] = { ...next[r.key], ...r.value };
	current = next;
	// the first start with this: whoever upstream counts as owner stays it
	if (!current.owner.id) {
		const id = await longestAdmin();
		if (id) await saveExtra("owner", { id });
	}
}

const longestAdmin = async () => (await sql`select id::text from users where role = 'admin' and instance is null order by created_at, id limit 1`)[0]?.id as string | undefined;

// the instance's owner (admin.ts ownerId): the saved one while it's still a
// local admin, else, as upstream has it, the longest-standing admin
export async function instanceOwner(): Promise<string | undefined> {
	const id = current.owner.id;
	if (id && (await sql`select 1 from users where id = ${id}::bigint and role = 'admin' and instance is null`).length) return id;
	return longestAdmin();
}

export const extras = () => current;

export async function saveExtra<K extends keyof Extras>(key: K, value: Extras[K]) {
	await sql`insert into instance_extras (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb) on conflict (key) do update set value = excluded.value`;
	current = { ...current, [key]: value };
}

// ── welcome ────────────────────────────────────────────────────────────────

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// a new account's welcome (invites.ts signUp); never fails the sign-up
export async function sendWelcome(userId: string) {
	try {
		const w = current.welcome;
		if (!w.enabled || !w.text.trim()) return;
		const [u] = await sql`select name, screen_name from users where id = ${userId}::bigint`;
		if (!u) return;
		const [from] = w.from
			? await sql`select id::text from users where lower(screen_name) = ${w.from.replace(/^@/, "").toLowerCase()} and instance is null and role is not null`
			: [];
		const body = fill(w.text, { instance: settings().instance_name, name: u.name || u.screen_name, handle: `@${u.screen_name}`, origin: PUBLIC_ORIGIN }).slice(0, 2000);
		await sql`insert into staff_messages (id, user_id, actor_id, kind, body) values (${newId()}::bigint, ${userId}::bigint, ${from?.id ?? null}::bigint, 'message', ${body})`;
	} catch (e) {
		console.error("welcome message:", e);
	}
}

// ── landing page ───────────────────────────────────────────────────────────

const PAGE_CSP = "connect-src 'self' blob: data:";

// X's signed-out page, opening its sign-in or sign-up dialog once it's drawn
const OPEN_SCRIPT = (flow: "login" | "signup") => `<script>(function(){
	var tries=0,t=setInterval(function(){
		var a=document.querySelector('a[href="/i/flow/${flow}"]');
		if(a){clearInterval(t);a.click()}else if(++tries>100)clearInterval(t);
	},100);
})();</script>`;

function when(d: Date) {
	const s = (Date.now() - new Date(d).getTime()) / 1000;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function recentPosts() {
	return sql`select p.id::text, p.text, p.created_at, u.screen_name, u.name
		from posts p join users u on u.id = p.user_id
		where u.instance is null and u.status = 'active' and u.deactivated_at is null and not u.protected
			and p.reply_to_id is null and p.community_id is null and not p.hidden and p.notice is null and char_length(p.text) > 0
		order by p.id desc limit 6`;
}

// signed out, "/" (server.ts); undefined leaves it to X's own page
export async function landingPage(req: Request, url: URL): Promise<Response | undefined> {
	const l = current.landing;
	if (!l.enabled) return undefined;
	const app = url.searchParams.get("app");
	if (app !== null) {
		const page = (await import("./shell")).shell(null);
		if (!page) return undefined;
		const flow = app === "signup" ? "signup" : app === "login" ? "login" : null;
		return new Response(flow ? page.replace("</body>", `${OPEN_SCRIPT(flow)}</body>`) : page, {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP },
		});
	}
	const s = settings();
	const name = s.instance_name;
	const [[stats], posts] = await Promise.all([
		sql`select (select count(*)::int from users where instance is null and status = 'active' and deactivated_at is null) as accounts,
			(select count(*)::int from posts p join users u on u.id = p.user_id where u.instance is null and p.created_at > now() - interval '7 days') as week`,
		l.posts ? recentPosts() : Promise.resolve([]),
	]);
	const closed = s.signup_mode === "closed";
	// an uploaded word mark (Admin > Settings, Logo and icons) stands in for the
	// name; the shipped one is Xitter's, not this instance's, so then the name shows
	const { brandingState } = await import("./branding");
	const uploaded = brandingState();
	const logo = uploaded["logo-dark"] || uploaded["logo-light"];
	// with one theme's logo only, the page keeps to that theme, or a white mark
	// would sit on a white page
	const scheme = !logo || (uploaded["logo-dark"] && uploaded["logo-light"]) ? "auto" : uploaded["logo-dark"] ? "dark" : "light";
	const heading = !logo
		? `<h1>${esc(name)}</h1>`
		: scheme === "auto"
			? `<h1 class="mark"><picture><source srcset="/public/logo-light.png" media="(prefers-color-scheme: light)"><img class="logo" src="/public/logo-dark.png" alt="${esc(name)}"></picture></h1>`
			: `<h1 class="mark"><img class="logo" src="/public/logo-${scheme}.png" alt="${esc(name)}"></h1>`;
	const LIGHT = ":root { --bg: #fff; --fg: #0f1419; --dim: #536471; --line: #eff3f4; --card: #f7f9f9; }";
	const lightCss = scheme === "light" ? LIGHT : scheme === "auto" ? `@media (prefers-color-scheme: light) { ${LIGHT} }` : "";
	const description = l.tagline || [...l.about].slice(0, 200).join("") || `${name}, a place to post`;
	const about = l.about.trim() ? l.about.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("") : "";
	// signed out, media isn't served, so a letter stands in for the avatar
	const hue = (h: string) => [...h].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
	const feed = posts.length
		? `<section class="feed" aria-label="Recent posts"><h2>Recently on ${esc(name)}</h2>${posts
				.map(
					(p: any) => `<article>
		<span class="av" aria-hidden="true" style="background:hsl(${hue(p.screen_name)} 55% 42%)">${esc([...String(p.name || p.screen_name)][0]?.toUpperCase() ?? "?")}</span>
		<div><div class="who"><b>${esc(p.name || p.screen_name)}</b> <span>@${esc(p.screen_name)} · <time datetime="${new Date(p.created_at).toISOString()}">${esc(when(p.created_at))}</time></span></div>
		<p>${esc([...String(p.text)].slice(0, 280).join(""))}</p></div>
	</article>`,
				)
				.join("")}</section>`
		: "";
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(PUBLIC_ORIGIN)}/">
<meta property="og:image" content="${esc(PUBLIC_ORIGIN)}/public/app-icon.png">
<meta name="twitter:card" content="summary">
${scheme === "auto" ? `<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">` : `<meta name="theme-color" content="${scheme === "dark" ? "#000000" : "#ffffff"}">`}
<link rel="apple-touch-icon" href="/public/app-icon.png">
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	:root { --bg: #000; --fg: #e7e9ea; --dim: #71767b; --line: #2f3336; --card: #16181c; --accent: #1d9bf0; }
	${lightCss}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.4 TwitterChirp, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
	main { max-width: 1040px; margin: 0 auto; padding: 48px 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: start; }
	@media (max-width: 800px) { main { grid-template-columns: 1fr; gap: 32px; padding-top: 32px; } }
	.mark { margin: 0 0 24px; line-height: 0; }
	.logo { max-width: min(320px, 100%); max-height: 96px; display: block; }
	h1 { font-size: clamp(36px, 6vw, 56px); line-height: 1.05; font-weight: 800; margin: 0 0 16px; letter-spacing: -.02em; }
	.tag { font-size: 20px; color: var(--dim); margin: 0 0 20px; }
	.about p { margin: 0 0 12px; white-space: pre-wrap; }
	.stats { color: var(--dim); margin: 20px 0 28px; }
	.stats b { color: var(--fg); }
	.buttons { display: flex; flex-direction: column; gap: 12px; max-width: 320px; }
	.btn { display: block; text-align: center; padding: 12px 16px; border-radius: 9999px; font-weight: 700; text-decoration: none; border: 1px solid var(--line); color: var(--accent); }
	.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
	.small { color: var(--dim); font-size: 13px; margin-top: 16px; }
	.small a { color: var(--accent); text-decoration: none; }
	.feed { border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
	.feed h2 { font-size: 20px; margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	article { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	article:last-child { border-bottom: 0; }
	.av { width: 40px; height: 40px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 17px; }
	.who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.who span { color: var(--dim); }
	article p { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
	<div>
		${heading}
		${l.tagline ? `<p class="tag">${esc(l.tagline)}</p>` : ""}
		${about ? `<div class="about">${about}</div>` : ""}
		<p class="stats"><b>${stats.accounts.toLocaleString("en-US")}</b> ${stats.accounts === 1 ? "account" : "accounts"} · <b>${stats.week.toLocaleString("en-US")}</b> ${stats.week === 1 ? "post" : "posts"} this week</p>
		<div class="buttons">
			${closed ? "" : `<a class="btn primary" href="/?app=signup">Create account</a>`}
			<a class="btn${closed ? " primary" : ""}" href="/?app=login">Sign in</a>
		</div>
		<p class="small">${s.signup_mode === "invite" ? "Sign-up needs an invite code. " : closed ? "Sign-up is closed right now. " : ""}<a href="/rules">Rules</a> · <a href="${esc(s.source_url)}">Source</a></p>
	</div>
	${feed}
</main>
</body>
</html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ── from this instance, on Explore ─────────────────────────────────────────

export const LOCAL_QUERY = "filter:local -filter:replies";

// the module at the top of Explore (graphql.ts explorePage)
export async function localExploreEntry(viewer: Viewer, sortIndex: string) {
	if (!current.local_explore.enabled) return undefined;
	const [{ searchPosts }, { postsByIds }, { tweetEntry }] = await Promise.all([import("./search"), import("./posts"), import("./model")]);
	const ids = await searchPosts(LOCAL_QUERY, { viewerId: viewer.id, top: false, limit: 5 });
	if (!ids.length) return undefined;
	const posts = await postsByIds(viewer.id, ids);
	const items = ids.flatMap((id) => {
		const p = posts.get(id);
		if (!p) return [];
		const e = tweetEntry(p, "0");
		return [{ entryId: `local-${sortIndex}-${e.entryId}`, item: { itemContent: e.content.itemContent } }];
	});
	if (!items.length) return undefined;
	return {
		entryId: `local-${sortIndex}`,
		sortIndex,
		content: {
			__typename: "TimelineTimelineModule",
			entryType: "TimelineTimelineModule",
			displayType: "Vertical",
			header: { displayType: "Classic", text: `From ${settings().instance_name}` },
			footer: { displayType: "Classic", text: "Show more", landingUrl: { url: `twitter://search/?query=${encodeURIComponent("filter:local")}&src=typed_query&f=live`, urlType: "DeepLink" } },
			items,
		},
	};
}
