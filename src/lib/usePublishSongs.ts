import { useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import type { SongWithStats } from "./useSongHistory";
import { bannerUrl } from "./useSongHistory";

const LS_PUBLISHED_KEY = "webfsr_published_song_keys";
const MAX_TRACKED = 2000; // cap how many keys we remember, oldest fall off first

function songKey(song: SongWithStats): string {
	return `${song.startTime}-${song.title}`;
}

function loadPublished(): Set<string> {
	try {
		const raw = localStorage.getItem(LS_PUBLISHED_KEY);
		if (!raw) return new Set();
		return new Set(JSON.parse(raw));
	} catch {
		return new Set();
	}
}

function savePublished(set: Set<string>) {
	try {
		const arr = Array.from(set).slice(-MAX_TRACKED);
		localStorage.setItem(LS_PUBLISHED_KEY, JSON.stringify(arr));
	} catch {
		// Ignore storage errors.
	}
}

// Publishes every song in `songs` that hasn't already been published, as
// soon as it appears -- this is what makes publishing "automatic" per
// song rather than needing a manual button. Dedup is tracked in
// localStorage (not just in-memory) so re-launching the app doesn't
// re-publish your whole history every time.
//
// Best-effort: if Supabase is unreachable, or the banner upload fails,
// the song still gets published (banner_url just ends up null) -- a
// missing banner shouldn't block the actual play from showing up in the
// feed. Failed inserts are simply retried on the next render/song update
// since the key never gets marked as published.
export function usePublishSongs(songs: SongWithStats[], playerName: string, mediaBaseUrl: string | null) {
	const publishedRef = useRef<Set<string>>(loadPublished());
	const inFlightRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const name = playerName.trim();
		if (!name) return;

		for (const song of songs) {
			const key = songKey(song);
			if (publishedRef.current.has(key) || inFlightRef.current.has(key)) continue;
			inFlightRef.current.add(key);

			(async () => {
				// If SongHRLog.lua already published this play directly to
				// Supabase (works without the desktop app open at all --
				// see the "supabaseId" field it writes back into the local
				// log once its own publish succeeds), merge HR/calories
				// into that same row instead of inserting a second one.
				if (song.supabaseId) {
					const { error: updateError } = await supabase
						.from("song_plays")
						.update({
							avg_hr: song.avgHr,
							max_hr: song.maxHr,
							calories: song.calories,
						})
						.eq("id", song.supabaseId);

					if (!updateError) {
						publishedRef.current.add(key);
						savePublished(publishedRef.current);
					}
					inFlightRef.current.delete(key);
					return;
				}

				let bannerUrlPublic: string | null = null;
				const localBanner = bannerUrl(mediaBaseUrl, song.bannerPath);

				if (localBanner) {
					try {
						const res = await fetch(localBanner);
						if (res.ok) {
							const blob = await res.blob();
							const ext = (song.bannerPath.split(".").pop() || "png").toLowerCase().slice(0, 5);
							const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
							const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
							const path = `${safeName}/${safeKey}.${ext}`;

							const { error: uploadError } = await supabase.storage.from("banners").upload(path, blob, {
								contentType: blob.type || "image/png",
								upsert: true,
							});

							if (!uploadError) {
								bannerUrlPublic = supabase.storage.from("banners").getPublicUrl(path).data.publicUrl;
							}
						}
					} catch {
						// Banner upload is best-effort -- publish the play regardless.
					}
				}

				const { error } = await supabase.from("song_plays").insert({
					player_name: name,
					title: song.title,
					artist: song.artist,
					pack: song.pack,
					difficulty: song.difficulty,
					difficulty_name: song.difficultyName,
					style: song.style,
					score: song.score,
					grade: song.grade,
					banner_url: bannerUrlPublic,
					duration_seconds: song.durationSeconds,
					avg_hr: song.avgHr,
					max_hr: song.maxHr,
					calories: song.calories,
					passed: song.passed,
					played_at: new Date(song.startTime * 1000).toISOString(),
				});

				if (!error) {
					publishedRef.current.add(key);
					savePublished(publishedRef.current);
				}
				inFlightRef.current.delete(key);
			})();
		}
	}, [songs, playerName, mediaBaseUrl]);
}
