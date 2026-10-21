// This instance only, not upstream: Settings > Accounts you manage
// (/account/manage). Someone an account added as an Admin delegate edits that
// account's profile here: name, bio, location, website, pronouns, profile
// photo and header. X's own client won't open its profile editor while
// switched into another account, so this page does it from the delegate's
// own session, no switching needed.
//
// The same rules as the account's own editor (rest.ts profileRoute): lengths,
// automod (a hit is a strike on the delegate, who typed it), blocked words and
// phrases (refused here, never suspending the account for its delegate's
// typing). Each save is in the audit log under the delegate.
// The handle, sign-in, settings and messages stay the owner's.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { hateIn, hateInName } from "./hate";
import { isId, newId } from "./ids";
import { MEDIA_DIR, sniffImage } from "./media";
import { automodStrike } from "./moderation";
import { blockedNameIn, blockedWordIn } from "./names";
import { MAX_PRONOUNS, pronounsProblem } from "./pronouns";
import { hasBlockedPhrase, settings } from "./settings";
import { cleanText, oneLine } from "./text-clean";
import type { MenuLink } from "./tidy";

type Managed = { id: string; screen_name: string; name: string; bio: string; location: string; website: string; pronouns: string | null; avatar_url: string | null; banner_url: string | null };

// the accounts `viewerId` is an accepted Admin delegate of
async function managed(viewerId: string, ownerId?: string): Promise<Managed[]> {
	return (await sql`select u.id::text, u.screen_name, u.name, u.bio, u.location, u.website, u.pronouns, u.avatar_url, u.banner_url
		from delegation_members d join users u on u.id = d.owner_id
		where d.member_id = ${viewerId}::bigint and d.role = 'Admin' and d.status = 'Accepted' and u.status <> 'suspended' and u.deactivated_at is null and u.instance is null
			${ownerId ? sql`and u.id = ${ownerId}::bigint` : sql``}
		order by lower(u.screen_name)`) as unknown as Managed[];
}

const PEOPLE = "M17.863 13.44c1.477 1.58 2.366 3.8 2.632 6.46l.11 1.1H3.395l.11-1.1c.266-2.66 1.155-4.88 2.632-6.46C7.627 11.85 9.648 11 12 11s4.373.85 5.863 2.44zM12 2C9.791 2 8 3.79 8 6s1.791 4 4 4 4-1.79 4-4-1.791-4-4-4z";

// Settings gets the page for anyone managing an account (tidy.ts menuLinks)
export async function manageLinks(userId: string): Promise<MenuLink[]> {
	const [r] = await sql`select count(*)::int as n from delegation_members where member_id = ${userId}::bigint and role = 'Admin' and status = 'Accepted'`;
	return r?.n ? [{ href: "/account/manage", text: "Accounts you manage", description: "Edit the profile of an account that made you its Admin delegate.", icon: PEOPLE, where: "both" }] : [];
}

const field = (label: string, name: string, value: string, max: number, extra = "") =>
	`<label for="${name}">${label}</label><input id="${name}" name="${name}" maxlength="${max}" value="${esc(value)}"${extra}>`;

const media = (url: string | null) => (url && /^\/media\/(?:banner\/)?\d{1,19}$/.test(url) ? url : null);

async function editor(req: Request, viewer: Viewer, u: Managed, note = "") {
	const avatar = media(u.avatar_url);
	const banner = media(u.banner_url);
	return accountPage({
		req,
		viewer,
		title: `Edit @${u.screen_name}`,
		back: { href: "/account/manage", label: "Accounts you manage" },
		body: `<h1>Edit @${esc(u.screen_name)}'s profile</h1>
	<p class="dim">You're an Admin delegate of this account. Changes show on its profile straight away, and are noted in the staff audit log under your name.</p>
	${note}
	<form method="post" action="/account/manage/${u.id}" enctype="multipart/form-data">
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<div class="card" style="padding:0;overflow:hidden">
		<div style="aspect-ratio:3/1;background:#333639 center/cover no-repeat${banner ? `;background-image:url(${banner})` : ""}"></div>
		<div style="padding:0 16px 12px"><img src="${avatar ?? "/abs/sticky/default_profile_images/default_profile_normal.png"}" alt="" style="width:88px;height:88px;border-radius:50%;object-fit:cover;margin-top:-44px;border:4px solid var(--bg);background:var(--bg)"></div>
	</div>
	<label for="avatar">Profile photo (PNG, JPEG, GIF or WebP, up to ${settings().limits.image_mb} MB)</label>
	<input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
	<label for="banner">Header (3:1 shows best)</label>
	<input id="banner" name="banner" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
	${banner ? `<label class="row" style="margin:0;color:inherit"><input type="checkbox" name="remove_banner" value="1" style="width:auto;min-height:0"> Remove the header</label>` : ""}
	${field("Name", "name", u.name, 50, " required")}
	<label for="bio">Bio</label>
	<textarea id="bio" name="bio" maxlength="160" rows="3">${esc(u.bio ?? "")}</textarea>
	${field("Location", "location", u.location ?? "", 30)}
	${field("Website", "website", u.website ?? "", 100, ' type="url" placeholder="https://"')}
	${field("Pronouns", "pronouns", u.pronouns ?? "", MAX_PRONOUNS)}
	<button type="submit">Save</button>
	</form>`,
	});
}

const problem = (text: string) => `<p class="error">${esc(text)}</p>`;

// a photo from the form, saved as the account's own upload
async function savePhoto(ownerId: string, file: unknown): Promise<string | undefined | Error> {
	if (!(file instanceof File) || !file.size) return undefined;
	const max = settings().limits.image_mb * 1024 * 1024;
	if (file.size > max) return new Error(`Images are up to ${settings().limits.image_mb} MB.`);
	const data = Buffer.from(await file.arrayBuffer());
	const image = sniffImage(data);
	if (!image) return new Error("Use a PNG, JPEG, GIF or WebP image.");
	const id = newId();
	mkdirSync(MEDIA_DIR, { recursive: true });
	writeFileSync(join(MEDIA_DIR, id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height) values (${id}::bigint, ${ownerId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height})`;
	return id;
}

export async function manageRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	if (viewer.actor) return accountPage({ req, viewer, title: "Accounts you manage", status: 403, body: `<h1>Accounts you manage</h1><p class="dim">Switch back to your own account first.</p>` });
	const id = /^\/account\/manage\/(\d{1,19})$/.exec(url.pathname)?.[1];
	if (!id || !isId(id)) {
		const list = await managed(viewer.id);
		return accountPage({
			req,
			viewer,
			title: "Accounts you manage",
			body: `<h1>Accounts you manage</h1>
	<p class="dim">Accounts that made you an Admin delegate (Settings, Delegate). You can edit their profile here; their handle, sign-in and settings stay theirs.</p>
	${
		list.length
			? list
					.map(
						(u) => `<a class="card" href="/account/manage/${u.id}" style="display:flex;gap:12px;align-items:center;text-decoration:none;color:inherit">
		<img src="${media(u.avatar_url) ?? "/abs/sticky/default_profile_images/default_profile_normal.png"}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover">
		<span><b>${esc(u.name)}</b><br><span class="dim">@${esc(u.screen_name)}</span></span><span style="margin-left:auto" class="dim">Edit ›</span></a>`,
					)
					.join("")
			: `<p class="dim">No account has made you an Admin delegate.</p>`
	}`,
		});
	}
	const [u] = await managed(viewer.id, id);
	if (!u) return accountPage({ req, viewer, title: "Accounts you manage", status: 404, body: `<h1>Accounts you manage</h1><p class="dim">You don't manage that account (or it's suspended).</p>` });
	if (req.method !== "POST") return editor(req, viewer, u);

	const f = await req.formData().catch(() => undefined);
	if (!f || String(f.get("csrf") ?? "") !== viewer.csrf) return editor(req, viewer, u, problem("That form is out of date. Try again."));
	const get = (k: string) => String(f.get(k) ?? "");
	const values = {
		name: oneLine(get("name")),
		bio: cleanText(get("bio"), { lines: 6 }),
		location: oneLine(get("location")),
		website: oneLine(get("website")),
		pronouns: oneLine(get("pronouns")).trim(),
	};
	const limits: Record<keyof typeof values, number> = { name: 50, bio: 160, location: 30, website: 100, pronouns: MAX_PRONOUNS };
	// every field checked before any is saved, as the account's own editor does
	for (const [k, v] of Object.entries(values) as [keyof typeof values, string][]) {
		if ([...v].length > limits[k]) return editor(req, viewer, { ...u, ...values }, problem(`The ${k} is limited to ${limits[k]} characters.`));
		const hate = k === "name" ? hateInName(v) : hateIn(v);
		if (hate) {
			// the strike is the delegate's: they wrote it, and the account shouldn't
			// be suspended for what someone it trusted typed
			await automodStrike(viewer.id, hate, k === "name" ? "name" : "profile", v);
			return editor(req, viewer, { ...u, ...values }, problem("That contains a slur or hate speech this instance doesn't allow."));
		}
		if (k === "name" ? blockedNameIn(v) : blockedWordIn(v)) return editor(req, viewer, { ...u, ...values }, problem(`The ${k} contains a word this instance doesn't allow.`));
		if (hasBlockedPhrase(v)) return editor(req, viewer, { ...u, ...values }, problem(`The ${k} contains a phrase this instance doesn't allow.`));
	}
	if (!values.name) return editor(req, viewer, { ...u, ...values }, problem("The name can't be blank."));
	if (values.website && !/^https?:\/\/\S+$/.test(values.website)) return editor(req, viewer, { ...u, ...values }, problem("The website must be an http or https address."));
	const pronounsBad = values.pronouns && pronounsProblem(values.pronouns);
	if (pronounsBad) return editor(req, viewer, { ...u, ...values }, problem(pronounsBad));

	const avatar = await savePhoto(u.id, f.get("avatar"));
	if (avatar instanceof Error) return editor(req, viewer, { ...u, ...values }, problem(avatar.message));
	const banner = await savePhoto(u.id, f.get("banner"));
	if (banner instanceof Error) return editor(req, viewer, { ...u, ...values }, problem(banner.message));

	await sql`update users set name = ${values.name}, bio = ${values.bio}, location = ${values.location}, website = ${values.website}, pronouns = ${values.pronouns || null},
		avatar_url = ${avatar ? `/media/${avatar}` : u.avatar_url},
		banner_url = ${banner ? `/media/banner/${banner}` : get("remove_banner") === "1" ? null : u.banner_url}
		where id = ${u.id}::bigint`;
	const changed = [...(Object.keys(values) as (keyof typeof values)[]).filter((k) => (values[k] || null) !== ((u as any)[k] || null)), ...(avatar ? ["avatar"] : []), ...(banner || get("remove_banner") === "1" ? ["banner"] : [])];
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, ${viewer.id}::bigint, 'delegate_profile_edit', ${u.id}, ${JSON.stringify({ changed })}::text::jsonb)`;
	const [fresh] = await managed(viewer.id, u.id);
	return editor(req, viewer, fresh ?? u, `<div class="card success"><b>Saved</b><div class="meta"><a href="/${esc(u.screen_name)}">See @${esc(u.screen_name)}'s profile</a></div></div>`);
}
