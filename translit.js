// Devanagari (Hindi) to romanized Hindi, the way lyrics are usually typed ("tum hi ho", "pyaar",
// "zindagi"). The caption font only has the Latin alphabet, and Whisper writes Hindi in Devanagari.
// Pure functions, no browser code.

const VOWELS = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
};

// Vowel signs that follow a consonant.
const MATRAS = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};

const CONSONANTS = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "ळ": "l",
  // With a nukta (the dot below), precomposed.
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f", "य़": "y",
};
// The same consonants written as base + nukta.
const NUKTA_FORMS = { "क": "q", "ख": "kh", "ग": "gh", "ज": "z", "ड": "d", "ढ": "dh", "फ": "f", "य": "y" };

const VIRAMA = "्";
const NUKTA = "़";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";
const DIGITS = "०१२३४५६७८९";

const isDevanagari = (ch) => ch >= "ऀ" && ch <= "ॿ";

// One word (only Devanagari letters) -> Latin.
function word(w) {
  // Split into syllables ("aksharas"): { cons: [..consonants], vowel: string | null (inherent "a"),
  // inherent: bool, nasal: "", standalone vowel }.
  const syl = [];
  let cur = null;
  const chars = [...w.normalize("NFC")];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (CONSONANTS[ch] !== undefined) {
      let latin = CONSONANTS[ch];
      if (chars[i + 1] === NUKTA && NUKTA_FORMS[ch]) {
        latin = NUKTA_FORMS[ch];
        i++;
      }
      if (cur && cur.halant) {
        // A conjunct: this consonant joins the previous one, and the syllable gets its "a" back.
        cur.cons.push(latin);
        cur.halant = false;
        cur.vowel = "a";
        cur.inherent = true;
      } else {
        cur = { cons: [latin], vowel: "a", inherent: true, nasal: "", halant: false };
        syl.push(cur);
      }
    } else if (MATRAS[ch] !== undefined && cur) {
      cur.vowel = MATRAS[ch];
      cur.inherent = false;
    } else if (ch === VIRAMA && cur) {
      cur.halant = true;
      cur.vowel = "";
      cur.inherent = false;
    } else if (VOWELS[ch] !== undefined) {
      cur = { cons: [], vowel: VOWELS[ch], inherent: false, nasal: "", halant: false };
      syl.push(cur);
    } else if ((ch === ANUSVARA || ch === CHANDRABINDU) && cur) {
      cur.nasal = "n";
    } else if (ch === VISARGA && cur) {
      cur.nasal += "h";
    } else if (ch === NUKTA) {
      // a stray nukta: ignore
    } else {
      // anything else (shouldn't happen inside a word)
      cur = { cons: [], vowel: ch, inherent: false, nasal: "", halant: false };
      syl.push(cur);
    }
  }

  // Hindi drops the inherent "a" at the end of a word (कम = "kam") and between a vowel and a vowel
  // when nothing else is in the way (दिलबर = "dil-bar"). Worked right to left, as in Ohala's rule.
  const n = syl.length;
  for (let i = n - 1; i >= 1; i--) {
    const s = syl[i];
    if (!s.inherent || s.cons.length === 0) continue;
    if (i === n - 1) {
      s.vowel = "";
      continue;
    }
    const prev = syl[i - 1];
    const next = syl[i + 1];
    const prevOpen = prev.vowel !== "" && !prev.nasal && !prev.halant;
    const nextVowel = next.vowel !== "" && next.cons.length === 1;
    if (prevOpen && nextVowel && s.cons.length === 1 && !s.nasal) s.vowel = "";
  }

  let out = "";
  syl.forEach((s, i) => {
    let v = s.vowel;
    const last = i === n - 1;
    // Long vowels are usually typed short at the end of a word ("bina", "hi", "meri", "tu").
    if (last && !s.nasal && v === "aa") v = "a";
    if (last && !s.nasal && v === "ee") v = "i";
    if (last && !s.nasal && v === "oo") v = "u";
    out += s.cons.join("") + v + s.nasal;
  });
  return out;
}

// Any text: Devanagari words are romanized, everything else is kept.
export function transliterate(text) {
  let out = "";
  let run = "";
  const flush = () => {
    if (run) out += word(run);
    run = "";
  };
  for (const ch of String(text).normalize("NFC")) {
    if (DIGITS.includes(ch)) {
      flush();
      out += String(DIGITS.indexOf(ch));
    } else if (ch === "।" || ch === "॥") {
      flush();
      out += ",";
    } else if (isDevanagari(ch)) {
      run += ch;
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out.replace(/,\s*$/, "").replace(/\s+,/g, ",");
}

export function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(text);
}
