import { createClient } from "@supabase/supabase-js";

// This is the "Publishable" (formerly "anon") key -- Supabase's own docs
// say this is safe to ship in client-side/public code as long as Row Level
// Security is enabled on the tables it touches, which it is here (see the
// song_plays and storage.objects policies from setup). It is NOT a secret.
const SUPABASE_URL = "https://zhmxkdtutmdnovidseet.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x7wOsBeiWAn5BswLN1UE-g_W1ppOGqU";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

export interface PublicSongPlay {
	id: string;
	player_name: string;
	title: string;
	artist: string;
	pack: string;
	difficulty: number;
	difficulty_name: string;
	style: string;
	score: string;
	grade: string;
	banner_url: string | null;
	duration_seconds: number;
	avg_hr: number | null;
	max_hr: number | null;
	calories: number | null;
	passed: boolean;
	played_at: string; // ISO timestamp
}
