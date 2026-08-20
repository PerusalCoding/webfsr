// HR-based calorie estimation using the Keytel et al. (2005) regression
// equations. These need average HR over the interval, weight, age, and
// biological sex -- there's no way to get a meaningful calorie estimate
// from HR alone, hence the biometrics fields in useBiometrics.ts.
//
// Source formulas (kcal/min):
//   Male:   ((-55.0969 + 0.6309*HR + 0.1988*weightKg + 0.2017*age) / 4.184)
//   Female: ((-20.4022 + 0.4472*HR + 0.1263*weightKg + 0.074*age) / 4.184)
//
// These are population averages, not a medical-grade measurement -- treat
// the output as a rough estimate, same as a fitness watch would give you.

export type BiologicalSex = "male" | "female";

export interface Biometrics {
	weightKg: number;
	age: number;
	sex: BiologicalSex;
}

export function estimateCalories(avgHeartrate: number, durationSeconds: number, biometrics: Biometrics): number | null {
	if (!avgHeartrate || avgHeartrate <= 0 || durationSeconds <= 0) return null;
	if (!biometrics.weightKg || !biometrics.age) return null;

	const minutes = durationSeconds / 60;
	const { weightKg, age, sex } = biometrics;

	const kcalPerMin =
		sex === "male"
			? (-55.0969 + 0.6309 * avgHeartrate + 0.1988 * weightKg + 0.2017 * age) / 4.184
			: (-20.4022 + 0.4472 * avgHeartrate + 0.1263 * weightKg + 0.074 * age) / 4.184;

	const total = kcalPerMin * minutes;
	return total > 0 ? Math.round(total) : null;
}
