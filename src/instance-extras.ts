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
// - Stats: /stats, open to anyone: accounts, posts, hashtags this week and
//   the instances this one federates with, from a cache a few minutes old.
// - Public pages: a shared link to a post or profile opens for someone
//   signed out (instance-public.ts).
// - Featured accounts: a few handles an admin picks, shown on the landing page.
// - Daily digest: once a day, the day's sign-ups, posts, open reports and
//   errors, imports waiting and storage, to a Discord or ntfy webhook (or any
//   URL that takes a JSON post).
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
	landing: { enabled: boolean; tagline: string; about: string; posts: boolean; featured: string[] };
	local_explore: { enabled: boolean };
	owner: { id: string };
	stats: { enabled: boolean };
	public_pages: { enabled: boolean };
	digest: { url: string; hour: number; last: string };
};

const DEFAULTS: Extras = {
	welcome: {
		enabled: true,
		from: "",
		text: "Welcome to {instance}, {name}!\n\nHave a look at the rules ({origin}/rules), say hello in a first post, and find people in Explore. Accounts from other instances show their instance after their handle.\n\nIf you need a hand, ask the staff.",
	},
	landing: { enabled: true, tagline: "", about: "", posts: true, featured: [] },
	local_explore: { enabled: true },
	owner: { id: "" },
	stats: { enabled: true },
	public_pages: { enabled: true },
	digest: { url: "", hour: 9, last: "" },
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
	// the accounts an admin features, in the order given, while still public
	const featured = l.featured.length
		? ((await sql`select u.screen_name, u.name, u.bio, u.avatar_url from users u
				where lower(u.screen_name) = any(${sql.array(l.featured.map((h) => h.toLowerCase()), "TEXT")}) and u.instance is null
					and not u.protected and u.status = 'active' and u.deactivated_at is null`) as any[]).sort(
				(a, b) => l.featured.findIndex((h) => h.toLowerCase() === a.screen_name.toLowerCase()) - l.featured.findIndex((h) => h.toLowerCase() === b.screen_name.toLowerCase()),
			)
		: [];
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
	// signed out, media isn't served (but for the shared-link pages' own, while
	// they're on), so a letter stands in for the avatar
	const hue = (h: string) => [...h].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
	const pub = current.public_pages.enabled;
	const avatarOf = (u: any, size = 40) => {
		const id = /^\/media\/(\d{1,19})$/.exec(u.avatar_url ?? "")?.[1];
		return id && pub
			? `<img class="av" src="/p/media/${id}" alt="" style="width:${size}px;height:${size}px;object-fit:cover">`
			: `<span class="av" aria-hidden="true" style="width:${size}px;height:${size}px;background:hsl(${hue(u.screen_name)} 55% 42%)">${esc([...String(u.name || u.screen_name)][0]?.toUpperCase() ?? "?")}</span>`;
	};
	const people = featured.length
		? `<section class="feed people" aria-label="Featured accounts"><h2>Who's here</h2>${featured
				.map((u: any) => `<${pub ? `a href="/${esc(u.screen_name)}"` : "div"} class="person">${avatarOf(u)}<div><div class="who"><b>${esc(u.name || u.screen_name)}</b> <span>@${esc(u.screen_name)}</span></div>${u.bio ? `<p>${esc([...String(u.bio)].slice(0, 120).join(""))}</p>` : ""}</div></${pub ? "a" : "div"}>`)
				.join("")}</section>`
		: "";
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
	.stack { display: grid; gap: 16px; }
	.feed { border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
	.person { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
	.person:last-child { border-bottom: 0; }
	a.person:hover { background: var(--card); }
	.person p { margin: 2px 0 0; color: var(--dim); }
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
		<p class="small">${s.signup_mode === "invite" ? "Sign-up needs an invite code. " : closed ? "Sign-up is closed right now. " : ""}<a href="/rules">Rules</a>${current.stats.enabled ? ` · <a href="/stats">Stats</a>` : ""} · <a href="${esc(s.source_url)}">Source</a></p>
	</div>
	<div class="stack">${people}${feed}</div>
</main>
</body>
</html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ── stats ──────────────────────────────────────────────────────────────────

type Stats = {
	accounts: number; joined_week: number; posts: number; posts_week: number; posters_week: number;
	days: { day: string; posts: number }[]; weeks: { week: string; joined: number }[];
	tags: { tag: string; posts: number }[]; peers: { id: string; name: string; accounts: number }[];
};
let statsCache: { at: number; data: Promise<Stats> } | undefined;

async function readStats(): Promise<Stats> {
	const [{ cachedTrends }, { peers }] = await Promise.all([import("./search"), import("./federation")]);
	const local = sql`u.instance is null and u.status <> 'suspended' and u.deactivated_at is null`;
	const [[c], days, weeks, tags, counts] = await Promise.all([
		sql`select (select count(*)::int from users u where ${local}) as accounts,
			(select count(*)::int from users u where ${local} and u.created_at > now() - interval '7 days') as joined_week,
			(select count(*)::int from posts p join users u on u.id = p.user_id where ${local}) as posts,
			(select count(*)::int from posts p join users u on u.id = p.user_id where ${local} and p.created_at > now() - interval '7 days') as posts_week,
			(select count(distinct p.user_id)::int from posts p join users u on u.id = p.user_id where ${local} and p.created_at > now() - interval '7 days') as posters_week`,
		sql`select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from posts p join users u on u.id = p.user_id
				where ${local} and p.created_at >= d and p.created_at < d + interval '1 day') as posts
			from generate_series(current_date - 13, current_date, interval '1 day') d order by d`,
		sql`select to_char(w, 'YYYY-MM-DD') as week, (select count(*)::int from users u where ${local} and u.created_at >= w and u.created_at < w + interval '7 days') as joined
			from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '7 days') w order by w`,
		cachedTrends(7, 10, {}).catch(() => []),
		sql`select instance, count(*)::int as accounts from users where instance is not null group by instance`,
	]);
	const known = new Map(counts.map((r: any) => [r.instance, r.accounts]));
	const list = peers().map((p) => ({ id: p.id, name: p.name || p.id, accounts: (known.get(p.id) as number) ?? 0 })).sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));
	return { ...(c as any), days: [...days] as any, weeks: [...weeks] as any, tags, peers: list };
}

const n = (x: number) => x.toLocaleString("en-US");
function bars(rows: { label: string; value: number }[], what: string) {
	const max = Math.max(1, ...rows.map((r) => r.value));
	return `<div class="bars">${rows.map((r) => `<div title="${esc(r.label)}: ${n(r.value)} ${what}" style="height:${Math.max(2, (r.value / max) * 100)}%"></div>`).join("")}</div>
	<div class="axis"><span>${esc(rows[0]?.label ?? "")}</span><span>${esc(rows.at(-1)?.label ?? "")}</span></div>`;
}

// /stats (server.ts); undefined when an admin turned it off
export async function statsPage(): Promise<Response | undefined> {
	if (!current.stats.enabled) return undefined;
	if (!statsCache || Date.now() - statsCache.at > 5 * 60_000) {
		const data = readStats();
		statsCache = { at: Date.now(), data };
		data.catch(() => (statsCache = undefined));
	}
	const st = await statsCache.data;
	const name = settings().instance_name;
	const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	const tile = (label: string, value: number, note = "") => `<div class="tile"><span>${esc(label)}</span><b>${n(value)}</b>${note ? `<em>${esc(note)}</em>` : ""}</div>`;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stats · ${esc(name)}</title>
<meta name="description" content="${esc(`${n(st.accounts)} accounts and ${n(st.posts_week)} posts this week on ${name}`)}">
<meta property="og:title" content="${esc(`${name} in numbers`)}">
<meta property="og:description" content="${esc(`${n(st.accounts)} accounts · ${n(st.posts_week)} posts this week · ${n(st.peers.length)} connected instances`)}">
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	:root { --bg: #000; --fg: #e7e9ea; --dim: #71767b; --line: #2f3336; --card: #16181c; --accent: #1d9bf0; }
	@media (prefers-color-scheme: light) { :root { --bg: #fff; --fg: #0f1419; --dim: #536471; --line: #eff3f4; --card: #f7f9f9; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.4 TwitterChirp, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
	main { max-width: 960px; margin: 0 auto; padding: 40px 16px 64px; }
	a { color: var(--accent); text-decoration: none; }
	header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
	h1 { margin: 0; font-size: clamp(28px, 5vw, 40px); font-weight: 800; letter-spacing: -.02em; }
	h2 { font-size: 17px; margin: 0 0 12px; }
	.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
	.tile, .box { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; }
	.tile span { color: var(--dim); font-size: 13px; }
	@media (max-width: 400px) { .tile { padding: 14px; } .tile b { font-size: 24px !important; } }
	.tile b { display: block; font-size: 30px; font-weight: 800; letter-spacing: -.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
	.tile em { color: var(--dim); font-size: 13px; font-style: normal; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 12px; }
	.bars { display: flex; align-items: flex-end; gap: 4px; height: 120px; }
	.bars div { flex: 1; background: var(--accent); border-radius: 4px 4px 1px 1px; opacity: .9; }
	.axis { display: flex; justify-content: space-between; color: var(--dim); font-size: 12px; margin-top: 6px; }
	ol, ul { margin: 0; padding: 0; list-style: none; }
	li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
	li:last-child { border-bottom: 0; }
	li span { color: var(--dim); white-space: nowrap; }
	li a, li b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.empty { color: var(--dim); }
	footer { color: var(--dim); font-size: 13px; margin-top: 20px; }
</style>
</head>
<body>
<main>
	<header><h1>${esc(name)} in numbers</h1><a href="/">${esc(name)} →</a></header>
	<div class="tiles">
		${tile("Accounts", st.accounts, st.joined_week ? `+${n(st.joined_week)} this week` : "")}
		${tile("Posts", st.posts)}
		${tile("Posts this week", st.posts_week)}
		${tile("People posting this week", st.posters_week)}
		${tile("Connected instances", st.peers.length)}
	</div>
	<div class="grid">
		<section class="box"><h2>Posts a day</h2>${bars(st.days.map((d) => ({ label: short(d.day), value: d.posts })), "posts")}</section>
		<section class="box"><h2>New accounts a week</h2>${bars(st.weeks.map((w) => ({ label: short(w.week), value: w.joined })), "new accounts")}</section>
	</div>
	<div class="grid">
		<section class="box"><h2>Busiest hashtags this week</h2>${
			st.tags.length ? `<ol>${st.tags.map((t) => `<li><b>${esc(t.tag)}</b><span>${n(t.posts)} ${t.posts === 1 ? "post" : "posts"}</span></li>`).join("")}</ol>` : `<p class="empty">No hashtags trending yet.</p>`
		}</section>
		<section class="box"><h2>Instances ${esc(name)} federates with</h2>${
			st.peers.length
				? `<ul>${st.peers.map((p) => `<li><a href="https://${esc(p.id)}" rel="noopener">${esc(p.name)}</a><span>${p.accounts ? `${n(p.accounts)} ${p.accounts === 1 ? "account" : "accounts"} seen here` : esc(p.id)}</span></li>`).join("")}</ul>`
				: `<p class="empty">This instance doesn't federate with others.</p>`
		}</section>
	</div>
	<footer>Counts are this instance's own accounts, without suspended or deactivated ones, and update every few minutes.</footer>
</main>
</body>
</html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

// ── daily digest ───────────────────────────────────────────────────────────

async function digestText() {
	const [d] = await sql`select
		(select count(*)::int from users where instance is null and created_at > now() - interval '1 day') as joined,
		(select count(*)::int from users where instance is null and status <> 'suspended' and deactivated_at is null) as accounts,
		(select count(*)::int from posts p join users u on u.id = p.user_id where u.instance is null and p.created_at > now() - interval '1 day') as posts,
		(select count(distinct p.user_id)::int from posts p join users u on u.id = p.user_id where u.instance is null and p.created_at > now() - interval '1 day') as posters,
		(select count(*)::int from reports where status = 'open') as reports,
		(select count(*)::int from error_log where not resolved) as errors,
		(select count(*)::int from archive_imports where state = 'pending') as imports,
		(select coalesce(sum(size), 0)::float8 from media) as media_bytes,
		pg_database_size(current_database())::float8 as db_bytes`;
	const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
	const name = settings().instance_name;
	const attention = [d.reports && `${d.reports} open report${d.reports === 1 ? "" : "s"}`, d.errors && `${d.errors} unresolved error${d.errors === 1 ? "" : "s"}`, d.imports && `${d.imports} import${d.imports === 1 ? "" : "s"} waiting for approval`].filter(Boolean);
	const lines = [
		`👋 ${d.joined} new account${d.joined === 1 ? "" : "s"} (${d.accounts.toLocaleString("en-US")} in all)`,
		`📝 ${d.posts.toLocaleString("en-US")} post${d.posts === 1 ? "" : "s"} from ${d.posters} ${d.posters === 1 ? "person" : "people"}`,
		attention.length ? `⚠️ ${attention.join(", ")}: ${PUBLIC_ORIGIN}/admin` : "✅ Nothing waiting for staff",
		`💾 Media ${gb(d.media_bytes)}, database ${gb(d.db_bytes)}`,
	];
	return { title: `${name} · the last 24 hours`, body: lines.join("\n") };
}

// Discord's webhooks, ntfy topics, or JSON { title, text } for anything else
export async function sendDigest(url = current.digest.url) {
	if (!/^https?:\/\//.test(url)) throw new Error("Set a webhook address first.");
	const { title, body } = await digestText();
	const discord = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url);
	const ntfy = /ntfy/.test(new URL(url).hostname);
	const r = await fetch(url, {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
		...(discord
			? { headers: { "content-type": "application/json" }, body: JSON.stringify({ username: settings().instance_name, content: `**${title}**\n${body}` }) }
			: ntfy
				? { headers: { title: title.replace(" · ", " - ").replace(/[^\x20-\x7e]/g, ""), tags: "bar_chart" }, body }
				: { headers: { "content-type": "application/json" }, body: JSON.stringify({ title, text: body }) }),
	});
	if (!r.ok) throw new Error(`The webhook answered ${r.status}.`);
}

// every ten minutes: past the hour (UTC) and not sent today, it goes
setInterval(() => {
	const d = current.digest;
	const today = new Date().toISOString().slice(0, 10);
	if (!d.url || d.last === today || new Date().getUTCHours() < d.hour) return;
	saveExtra("digest", { ...d, last: today })
		.then(() => sendDigest())
		.catch((e) => console.error("daily digest:", e.message));
}, 10 * 60_000).unref();

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
