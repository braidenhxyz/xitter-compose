// Admin > Instance extras (admin.html): the panel's side of instance-extras.ts.
// Only admin.ts imports this file, so admin.ts has always loaded first.

import { type Action, AdminError, audit, guard } from "./admin";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { extras, instanceOwner, saveExtra } from "./instance-extras";

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
			return { extras: extras(), owner: { you: a.id === owner, screen_name: o?.screen_name ?? null }, admins };
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
			const landing = { enabled: on(l.enabled, "to use the landing page"), tagline: text(l.tagline, 140).trim(), about: text(l.about, 1500).trim(), posts: on(l.posts, "to show recent posts") };
			const local_explore = { enabled: on(x.enabled, "Explore shows this instance's posts") };
			const stats = { enabled: on(((b.stats ?? {}) as Record<string, unknown>).enabled, "the stats page is open") };
			const public_pages = { enabled: on(((b.public_pages ?? {}) as Record<string, unknown>).enabled, "shared links open for people signed out") };
			if (welcome.from && !(await sql`select 1 from users where lower(screen_name) = ${welcome.from.toLowerCase()} and instance is null and role is not null`).length)
				throw new AdminError(`@${welcome.from} isn't a staff account here.`);
			await saveExtra("welcome", welcome);
			await saveExtra("landing", landing);
			await saveExtra("local_explore", local_explore);
			await saveExtra("stats", stats);
			await saveExtra("public_pages", public_pages);
			await audit(a, "save_instance_extras", null, { welcome: welcome.enabled, landing: landing.enabled, local_explore: local_explore.enabled, stats: stats.enabled, public_pages: public_pages.enabled });
			return {};
		},
	},
};
