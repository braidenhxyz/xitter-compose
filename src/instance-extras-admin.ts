// Admin > Instance extras (admin.html): the panel's side of instance-extras.ts.
// Only admin.ts imports this file, so admin.ts has always loaded first.

import { type Action, AdminError, audit } from "./admin";
import { sql } from "./db";
import { extras, saveExtra } from "./instance-extras";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").slice(0, max) : "");
const on = (v: unknown, what: string) => {
	if (typeof v !== "boolean") throw new AdminError(`Choose whether ${what}.`);
	return v;
};

// the panel's actions (admin.ts adds them to its own)
export const extrasActions: Record<string, Action> = {
	extras: { role: "admin", run: async () => ({ extras: extras() }) },
	saveExtras: {
		role: "admin",
		run: async (a, b) => {
			const w = (b.welcome ?? {}) as Record<string, unknown>;
			const l = (b.landing ?? {}) as Record<string, unknown>;
			const x = (b.local_explore ?? {}) as Record<string, unknown>;
			const welcome = { enabled: on(w.enabled, "new accounts get a welcome"), from: text(w.from, 51).trim().replace(/^@/, ""), text: text(w.text, 2000) };
			const landing = { enabled: on(l.enabled, "to use the landing page"), tagline: text(l.tagline, 140).trim(), about: text(l.about, 1500).trim(), posts: on(l.posts, "to show recent posts") };
			const local_explore = { enabled: on(x.enabled, "Explore shows this instance's posts") };
			if (welcome.from && !(await sql`select 1 from users where lower(screen_name) = ${welcome.from.toLowerCase()} and instance is null and role is not null`).length)
				throw new AdminError(`@${welcome.from} isn't a staff account here.`);
			await saveExtra("welcome", welcome);
			await saveExtra("landing", landing);
			await saveExtra("local_explore", local_explore);
			await audit(a, "save_instance_extras", null, { welcome: welcome.enabled, landing: landing.enabled, local_explore: local_explore.enabled });
			return {};
		},
	},
};
