import { describe, it, expect } from "vitest";
import { normalize, similarity, numbersOf, toFtsQuery } from "../src/text.js";

describe("normalize", () => {
  it("menyamakan huruf besar, tanda baca, dan spasi; titik versi dipertahankan", () => {
    expect(normalize("  Server produksi:  Ubuntu 24.04!! ")).toBe("server produksi ubuntu 24.04");
    expect(normalize("Café — résumé")).toBe("cafe resume");
  });
});

describe("similarity (ambang 0.6 dipilih dari data uji nyata)", () => {
  const T = 0.6;
  it.each([
    ["Server produksi pengguna memakai Ubuntu 24.04.", "Server produksi pengguna menjalankan Ubuntu 24.04."],
    ["Lebih suka jawaban dalam Bahasa Indonesia yang ringkas.", "Pengguna lebih suka jawaban ringkas dalam Bahasa Indonesia."],
    ["Stack utama pengguna Laravel 11 dan Flutter.", "Pengguna memakai Laravel 11 dan Flutter sebagai stack utama."],
  ])("parafrase dianggap mirip: %s", (a, b) => {
    expect(similarity(a, b)).toBeGreaterThanOrEqual(T);
  });

  it.each([
    ["Server produksi memakai Ubuntu 24.04", "Server staging memakai Ubuntu 22.04"],
    ["Stack utama pengguna Laravel 11 dan Flutter.", "Server produksi pengguna memakai Ubuntu 24.04."],
    ["Pengguna lebih suka jawaban ringkas.", "Pengguna lebih suka jawaban panjang dan detail."],
  ])("fakta berbeda tidak ditandai: %s", (a, b) => {
    expect(similarity(a, b)).toBeLessThan(T);
  });

  it("pembaruan versi terdeteksi mirip, dan angka berbeda bisa dibedakan", () => {
    expect(similarity("Pengguna memakai Laravel 10", "Pengguna memakai Laravel 11")).toBeGreaterThanOrEqual(T);
    expect(numbersOf("Pengguna memakai Laravel 10")).not.toEqual(numbersOf("Pengguna memakai Laravel 11"));
    expect(numbersOf("Ubuntu 24.04 dan PHP 8.3")).toEqual(["24.04", "8.3"]);
  });
});

describe("toFtsQuery", () => {
  it("mengutip kata dan membuang kata < 3 huruf serta karakter berbahaya", () => {
    expect(toFtsQuery('laravel" OR 1=1 -- ui')).toBe('"laravel"');
    expect(toFtsQuery("flutter NEAR(laravel)")).toBe('"flutter" OR "near" OR "laravel"');
    expect(toFtsQuery("ab")).toBeNull();
  });
});
