import { test } from "node:test";
import assert from "node:assert/strict";
import { transliterate, hasDevanagari } from "../translit.js";
import { cleanLine, chunksToLyrics } from "../lyrics.js";
import { parseLyrics } from "../editor.js";

const CASES = [
  ["तुम ही हो", "tum hi ho"],
  ["अब तुम ही हो", "ab tum hi ho"],
  ["ज़िंदगी", "zindagi"],
  ["प्यार", "pyaar"],
  ["दिलबर", "dilbar"],
  ["कमल", "kamal"],
  ["समझ", "samajh"],
  ["धड़कन", "dhadkan"],
  ["मैं", "main"],
  ["हूँ", "hoon"],
  ["तू", "tu"],
  ["आँखें", "aankhen"],
  ["तेरे बिना", "tere bina"],
  ["मोहब्बत", "mohabbat"],
  ["इश्क़", "ishq"],
  ["दुनिया", "duniya"],
  ["ख़्वाब", "khvaab"],
  ["क्या", "kya"],
  ["तुम्हारा", "tumhaara"],
  ["कभी कभी", "kabhi kabhi"],
  ["दिल दिया है जान भी देंगे", "dil diya hai jaan bhi denge"],
  ["मुझे तुमसे प्यार है", "mujhe tumse pyaar hai"],
  ["आशिक़ी", "aashiqi"],
];

test("transliterate: Devanagari lyrics come out as everyday romanized Hindi", () => {
  for (const [hindi, latin] of CASES) assert.equal(transliterate(hindi), latin, hindi);
});

test("transliterate: keeps Latin text and digits, turns the danda into a comma", () => {
  assert.equal(transliterate("Hello तुम 2"), "Hello tum 2");
  assert.equal(transliterate("दिल है। प्यार है।"), "dil hai, pyaar hai");
  assert.equal(transliterate("साल २०२४"), "saal 2024");
  assert.ok(hasDevanagari("तुम") && !hasDevanagari("tum"));
});

test("cleanLine: removes music tags and invented phrases, romanizes Hindi", () => {
  assert.equal(cleanLine(" [Music] ♪ तुम ही हो ♪ "), "tum hi ho");
  assert.equal(cleanLine("(singing) Let's go fishin'"), "Let's go fishin'");
  assert.equal(cleanLine("[Music]"), "");
  assert.equal(cleanLine("Thank you."), "");
  assert.equal(cleanLine("Thanks for watching!"), "");
  assert.equal(cleanLine("..."), "");
});

test("chunksToLyrics: timed lines in the original video's time, that the lyrics box accepts", () => {
  const lines = chunksToLyrics(
    [
      { timestamp: [0.5, 4.2], text: " [Music]" },
      { timestamp: [4.2, 8.0], text: " तुम ही हो" },
      { timestamp: [8.0, 12.4], text: " अब तुम ही हो" },
      { timestamp: [12.4, null], text: " ज़िंदगी" },
    ],
    60
  );
  assert.deepEqual(lines, ["1:04.2-1:08 tum hi ho", "1:08-1:12.4 ab tum hi ho", "1:12.4-1:16.4 zindagi"]);
  const { items, bad } = parseLyrics(lines.join("\n"));
  assert.deepEqual(bad, []);
  assert.deepEqual(items[0], { time: 64.2, end: 68, text: "tum hi ho" });
});

test("chunksToLyrics: a line repeated over and over is cut to two", () => {
  const chunk = (s, text) => ({ timestamp: [s, s + 2], text });
  const lines = chunksToLyrics([chunk(0, "la la"), chunk(2, "La la!"), chunk(4, "la la"), chunk(6, "la la"), chunk(8, "next line")]);
  assert.deepEqual(lines.map((l) => l.split(" ").slice(1).join(" ")), ["la la", "La la!", "next line"]);
});
