export interface Officer { id: number; kanji: string; reading: string }
export interface ManualMatch { id: number; reason: string }

export function parseRegistry(source: string): Officer[] {
  const lines = source.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  if (lines.shift() !== 'id\tname_kanji\treading') throw new Error('초상 registry 헤더가 다릅니다.');
  const ids = new Set<number>();
  return lines.map((line) => {
    const [rawId, kanji, reading, ...extra] = line.split('\t');
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 10001 || id > 11000 || ids.has(id) || !kanji || !reading || extra.length) {
      throw new Error(`초상 registry 행이 잘못되었습니다: ${rawId}`);
    }
    ids.add(id);
    return { id, kanji, reading };
  });
}

export function koreanName(kanji: string, readings: Readonly<Record<string, string>>): string {
  const translated = [...kanji].map((char, index) => {
    // Registry는 신자체 楽을 쓰지만 전통자 성씨 樂도 같은 악으로 받는다.
    if (index === 0 && char === '樂') return '악';
    const reading = Object.hasOwn(readings, char) ? readings[char] : undefined;
    if (!reading || !/^[가-힣]$/.test(reading)) throw new Error(`한자 독음이 없습니다: ${char}`);
    return reading;
  }).join('');
  if (!translated) throw new Error('이름이 비어 있습니다.');
  // 이름 맨 앞 음절에만 두음법칙을 적용한다. 제갈량의 량 등은 유지한다.
  const syllable = translated.charCodeAt(0) - 0xac00;
  const initial = Math.floor(syllable / 588);
  const vowel = Math.floor(syllable % 588 / 28);
  let changed = initial;
  if (initial === 5) changed = [2, 6, 7, 12, 17, 20].includes(vowel) ? 11 : 2;
  else if (initial === 2 && [6, 12, 17, 20].includes(vowel)) changed = 11;
  return String.fromCharCode(0xac00 + changed * 588 + syllable % 588) + translated.slice(1);
}

export function matchPortraits(names: readonly string[], officers: readonly Officer[],
  readings: Readonly<Record<string, string>>, manual: Readonly<Record<string, ManualMatch>> = {}) {
  const byName = new Map<string, Officer[]>();
  for (const officer of officers) {
    const name = koreanName(officer.kanji, readings);
    byName.set(name, [...(byName.get(name) ?? []), officer]);
  }
  const portraits: Record<string, number> = Object.create(null);
  const ambiguous: { name: string; candidates: Officer[] }[] = [];
  const unmatched: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    const candidates = byName.get(name) ?? [];
    const choice = Object.hasOwn(manual, name) ? manual[name] : undefined;
    if (choice) {
      const validId = (candidates.length ? candidates : officers).some((officer) => officer.id === choice.id);
      if (!choice.reason.trim() || !validId) {
        throw new Error(`${name}: 수동 대응에는 registry의 후보 ID와 구분 근거가 필요합니다.`);
      }
      portraits[name] = choice.id;
    } else if (candidates.length === 1) portraits[name] = candidates[0]!.id;
    else if (candidates.length > 1) ambiguous.push({ name, candidates: candidates.toSorted((a, b) => a.id - b.id) });
    else unmatched.push(name);
  }
  for (const name of Object.keys(manual)) if (!names.includes(name)) throw new Error(`시나리오에 없는 수동 대응: ${name}`);
  const matched = names.filter((name) => Object.hasOwn(portraits, name)).length;
  return { portraits, ambiguous, unmatched, manual, stats: { matched, total: names.length,
    percent: Math.round(matched / names.length * 10000) / 100 } };
}
