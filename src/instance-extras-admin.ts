// Admin > Instance extras (admin.html): the panel's side of instance-extras.ts.
// Only admin.ts imports this file, so admin.ts has always loaded first.

import { type Action, AdminError, audit, guard } from "./admin";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { extras, instanceOwner, saveExtra, sendDigest } from "./instance-extras";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").slice(0, max) : "");
const on = (v: unknown, what: string) => {
	if (typeof v !== "boolean") throw new AdminError(`Choose whether ${what}.`);
	return v;
};

// the owner's tools are the owner's alone, whatever their role says
async function ownerOnly(a: Viewer) {
	if (a.id !== (await instanceOwner())) throw new AdminError("Only the instance owner can do that.", 403);
}

// a local account by "@handle" or id
async function account(v: unknown) {
	const q = typeof v === "string" ? v.trim().replace(/^@/, "") : "";
	const [u] = /^\d{1,19}$/.test(q)
		? await sql`select id::text, screen_name, created_at from users where id = ${q}::bigint and instance is null`
		: await sql`select id::text, screen_name, created_at from users where lower(screen_name) = ${q.toLowerCase()} and instance is null`;
	if (!u) throw new AdminError(`There's no account ${q ? `@${q}` : ""} on this instance.`, 404);
	return u as { id: string; screen_name: string; created_at: Date };
}

// X opened in March 2006; nothing here joined before that, or after now
const FIRST = Date.UTC(2006, 2, 21);

// the panel's actions (admin.ts adds them to its own)
export const extrasActions: Record<string, Action> = {
	extras: {
		role: "admin",
		run: async (a) => {
			const owner = await instanceOwner();
			const [o] = owner ? await sql`select screen_name from users where id = ${owner}::bigint` : [];
			const admins = a.id === owner ? await sql`select id::text, screen_name from users where role = 'admin' and instance is null and id <> ${a.id}::bigint order by screen_name` : [];
			// a Discord webhook address lets anyone post as it: the owner's alone
			const x = extras();
			const shown = a.id === owner ? x : { ...x, digest: { ...x.digest, url: x.digest.url ? "set" : "" } };
			return { extras: shown, owner: { you: a.id === owner, screen_name: o?.screen_name ?? null }, admins };
		},
	},
	// the digest now, to check the webhook
	testDigest: {
		role: "admin",
		run: async (a, b) => {
			await ownerOnly(a);
			const url = typeof b.url === "string" && b.url.trim() ? b.url.trim() : extras().digest.url;
			try {
				await sendDigest(url);
			} catch (e) {
				throw new AdminError((e as Error).message);
			}
			await audit(a, "test_digest", null, {});
			return {};
		},
	},
	// an account's "Joined" date, on its profile and everywhere it shows
	ownerJoinDate: {
		role: "admin",
		run: async (a, b) => {
			await ownerOnly(a);
			const u = await account(b.account);
			await guard(a, u.id, true);
			const at = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(b.date) ? new Date(b.date.length === 10 ? `${b.date}T12:00:00Z` : `${b.date}:00Z`) : null;
			if (!at || Number.isNaN(at.getTime()) || at.getTime() < FIRST || at.getTime() > Date.now()) throw new AdminError("Pick a date between March 2006 and now.");
			await sql`update users set created_at = ${at} where id = ${u.id}::bigint`;
			await audit(a, "owner_join_date", u.id, { from: u.created_at, to: at });
			return { screen_name: u.screen_name, created_at: at };
		},
	},
	// the instance to another admin; the old owner stays an admin
	ownerTransfer: {
		role: "admin",
		run: async (a, b) => {
			await ownerOnly(a);
			const u = await account(b.account);
			if (u.id === a.id) throw new AdminError("You're the owner already.");
			if (!(await sql`select 1 from users where id = ${u.id}::bigint and role = 'admin'`).length) throw new AdminError(`@${u.screen_name} has to be an admin first.`);
			await saveExtra("owner", { id: u.id });
			await audit(a, "owner_transfer", u.id, {});
			return {};
		},
	},
	saveExtras: {
		role: "admin",
		run: async (a, b) => {
			const w = (b.welcome ?? {}) as Record<string, unknown>;
			const l = (b.landing ?? {}) as Record<string, unknown>;
			const x = (b.local_explore ?? {}) as Record<string, unknown>;
			const welcome = { enabled: on(w.enabled, "new accounts get a welcome"), from: text(w.from, 51).trim().replace(/^@/, ""), text: text(w.text, 2000) };
			const featured = (Array.isArray(l.featured) ? l.featured : String(l.featured ?? "").split(/[\s,]+/)).map((h) => String(h).trim().replace(/^@/, "")).filter((h) => /^\w{1,50}$/.test(h)).slice(0, 8);
			const landing = { enabled: on(l.enabled, "to use the landing page"), tagline: text(l.tagline, 140).trim(), about: text(l.about, 1500).trim(), posts: on(l.posts, "to show recent posts"), featured };
			const local_explore = { enabled: on(x.enabled, "Explore shows this instance's posts") };
			const stats = { enabled: on(((b.stats ?? {}) as Record<string, unknown>).enabled, "the stats page is open") };
			const public_pages = { enabled: on(((b.public_pages ?? {}) as Record<string, unknown>).enabled, "shared links open for people signed out") };
			const g = (b.digest ?? {}) as Record<string, unknown>;
			const hour = Number(g.hour ?? 9);
			if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new AdminError("The digest hour is 0 to 23 (UTC).");
			const digestUrl = text(g.url, 500).trim();
			if (digestUrl && !/^https?:\/\/\S+$/.test(digestUrl)) throw new AdminError("The digest webhook is an http or https address.");
			// the server fetches this address, so only the owner sets it: an admin
			// could otherwise use it to probe the server's own network
			const isOwner = a.id === (await instanceOwner());
			const digest = isOwner ? { url: digestUrl, hour, last: extras().digest.last } : extras().digest;
			if (welcome.from && !(await sql`select 1 from users where lower(screen_name) = ${welcome.from.toLowerCase()} and instance is null and role is not null`).length)
				throw new AdminError(`@${welcome.from} isn't a staff account here.`);
			await saveExtra("welcome", welcome);
			await saveExtra("landing", landing);
			await saveExtra("local_explore", local_explore);
			await saveExtra("stats", stats);
			await saveExtra("public_pages", public_pages);
			await saveExtra("digest", digest);
			await audit(a, "save_instance_extras", null, { welcome: welcome.enabled, landing: landing.enabled, local_explore: local_explore.enabled, stats: stats.enabled, public_pages: public_pages.enabled });
			return {};
		},
	},
};
