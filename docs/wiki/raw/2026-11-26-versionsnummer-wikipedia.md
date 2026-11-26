# Versionsnummer (German Wikipedia)

- URL: https://de.wikipedia.org/wiki/Versionsnummer
- Retrieved: 2026-11-26
- Revision: 267798157 (oldid), saved 2026-06-09T05:01:00Z,
  https://de.wikipedia.org/w/index.php?title=Versionsnummer&oldid=267798157
- Retrieved through the MediaWiki API (`action=query&prop=revisions&rvprop=ids|timestamp|content`)
  as wikitext and converted to Markdown. Wiki links are reduced to their text, templates to their
  content, references are listed at the end under "Einzelnachweise". The text is otherwise
  unchanged and stays in German.
- The original's en dashes are written as `&ndash;` here, because the repository's text rules
  forbid the character itself. Non-breaking spaces and hyphens are written as plain ones.
- License of the article text: CC BY-SA 4.0, authors in the article's version history.

The article carried a "Redundanztext" banner (July 2025) pointing to the overlap with
"Version (Software)#Semantic Versioning".

---

**Versionsnummern** unterscheiden einzelne Versionen einer Software, um deren Weiterentwicklungen
nachvollziehbar zu kennzeichnen.

Die Versionsnummer ist die Grundlage für die Versionsverwaltung. Den Prozess der Vergabe der
Versionsnummer nennt man Versionierung.

## Semantische Versionsnummer

Eine *semantische Versionsnummer* setzt sich aus folgenden Teilen zusammen:[1]

**Hauptversionsnummer**
: (englisch: *major release*) indiziert meist äußerst signifikante Änderung am Programm &ndash; zum
  Beispiel, wenn das Programm komplett neu geschrieben wurde (zum Beispiel GIMP 2.x nach der
  Version 1.x) oder sich bei Bibliotheken keine Schnittstellenkompatibilität aufrechterhalten lässt.

**Nebenversionsnummer**
: (englisch *minor release*) bezeichnet meistens die funktionale Erweiterung des Programms.

**Revisionsnummer**
: (englisch *patch level* oder *micro release*) enthält meist Fehlerbehebungen.

**Buildnummer**
: (englisch *build number*) kennzeichnet in der Regel den Fortschritt der Entwicklungsarbeit in
  Einzelschritten, wird also zum Beispiel bei 0001 beginnend mit jedem Kompilieren des Codes um
  eins erhöht. Version 5.0.0-3242 stünde also für das 3242. Kompilationsprodukt einer Software.
  Verwendet man Versionskontrollsysteme, so wird an Stelle der Build-Nummer gerne eine Nummer
  verwendet, die die Quellen zum Kompilat innerhalb des Versionskontrollsystems eindeutig
  identifiziert. Das erleichtert im Fehlerfall, die zugehörigen Quellen zu finden.[2]

Beispiel für die 2. Version eines Programms, in der 3. Nebenversion und in der 5. Fehlerkorrektur,
Build 0041:

```
2.3.5-0041
│ │ │  └────── Buildnummer
│ │ └───────── Revisionsnummer
│ └─────────── Nebenversionsnummer
└───────────── Hauptversionsnummer
```

Jede dieser Versionsnummern kann auch aus mehreren Ziffern bestehen. Zum Beispiel folgt nach
Version 0.9, wenn sich nur die Nebenversion erhöht, 0.10 und nicht 1.0. Bei manchen Programmen ist
daher die Nebenversionsnummer zweistellig oder enthält eine führende Null, wenn mit mehr als zehn
Versionen dieser Art zu rechnen ist (Beispiel: 0.09). Wird die Haupt- oder Nebenversionsnummer
erhöht, werden die folgenden Stellen, mit Ausnahme der Buildnummer, auf 0 zurückgesetzt. Auf die
Version 2.3.5 folgt also, je nach Grad der Änderung, die Version 2.3.6, 2.4.0 oder 3.0 (bzw. 3.0.0).

Häufig bildet die Hauptversion mit der Nummer 0 insofern eine Ausnahme, als auch bei einer Erhöhung
der Nebenversion größere Änderungen möglich sind.

Grundsätzlich gibt es für die Bedeutung der einzelnen Werte jedoch keine festen Vorgaben, vielmehr
haben sich Quasi-Standards etabliert: Unter dem .Net-Framework folgt man z. B. dem abweichenden
Schema `<Hauptversionsnummer>.<Nebenversionsnummer>.<Buildnummer>.<Revisionsnummer>`[3] (gegenüber
obigem Beispiel vertauschte Position für Revisionsnummer und Buildnummer). In .NET unterscheidet
man zudem zwischen unterschiedlichen Arten von Versionen:[4]

Versionsnummern im .Net-Framework:

| Versionsnummer | Beschreibung |
| --- | --- |
| `AssemblyFileVersion` | Version, welche einen individuellen Build bezeichnet. Die Version zählt hoch wenn eine neue Assembly erstellt wird, auch wenn der Quelltext identisch ist. |
| `AssemblyInformationalVersion` | Version eines Produktes, welches aus mehreren Assemblies besteht. |
| `AssemblyVersion` | Version einer Assembly. Die Version bleibt ident, wenn diese aus identischem Quelltext erstellt wurde. |

Zu einem Versionsstand an einem beliebigen Zeitpunkt sagt man auch Build. Die Build-Nummer wird in
vielen Projekten unabhängig von den anderen Nummern erhöht und nicht zurückgesetzt. Zum Beispiel
gibt es beim Betriebssystem Windows von Microsoft zwei Produktreihen: in der Windows 9x-Reihe sind
die Builds 950 (Windows 95), 1998 (Windows 98) und 2222 (Windows 98 SE) bekannt, in der Reihe
Windows NT-Reihe sind dies die Builds 1381 (Windows NT 4.0 Service Pack 6), 2600 (Windows XP), 6000
(Windows Vista), 7600 (Windows 7), 9200 (Windows 8) and 9600 (Windows 8.1). Seit Windows 10 trägt
jede Version eine eigene Build-Nummer.

Oftmals ist es &ndash; vor allem bei Open-Source-Software &ndash; der Fall, dass sich die
Versionsnummern von Programmen oder Systemen noch vor der Version 1.x befinden. Dies deutet jedoch
nicht zwingend darauf hin, dass die Entwicklung noch nicht weit fortgeschritten ist, sondern eher,
dass die Version noch nicht das von den Entwicklern gesteckte Ziel erreicht hat und sich weiterhin
in der Entwicklung befindet. Teilweise gibt es sogar Open-Source-Programme, die &ndash; obwohl sie
den Alpha- und Beta-Status längst verlassen haben &ndash; weiterhin noch unterhalb der Version 1.0
versioniert sind.

Eine Versionsnummer wird oft nach dem Programmnamen angeführt und manchmal durch „v.“, „v“ oder „V“
(für *Version*) speziell gekennzeichnet.

## Versionsnummer mit Datum

Ein alternativer Ansatz besteht darin, eine Versionsnummer mit einem Datum zu erstellen:

```
2024.10.12-0002
 │   │  │    └── Buildnummer (innerhalb des Tages)
 │   │  └─────── Tag
 │   └────────── Monat
 └────────────── Jahr
```

## Marketingaspekte

Für die Software-Entwicklung stellen Versionsnummern eine weitaus wichtigere Information als für den
Kunden dar. Mit Hilfe der Versionsnummern kann unter anderem sichergestellt werden, dass in
Entwicklergruppen neue Programmteile nicht mit älteren überschrieben werden (siehe
Versionsverwaltung).

In größeren Softwareprojekten wird unter Umständen aus Marketingaspekten von der internen, eher
technisch motivierten Versionierung abgewichen, was dann zu Versionsnamen führt (Windows XP
entspricht beispielsweise „Windows NT 5.1“), aus denen sich die Versionsfolge nicht mehr ohne
weiteres erkennen lässt. Aus Marketinggründen kann es auch zum Überspringen von Versionsnummern
kommen, um keine niedrigere Version (die als „älter“ interpretiert werden kann) als Mitwettbewerber
zu haben. Dies war beispielsweise bei WinWord, dessen Version von 2.0 auf 6.0 sprang, Slackware und
Windows 10 der Fall.
Auch bei verschiedener Software vom gleichen Hersteller kann es ähnliche Fälle geben, so wurde z. B.
die erste Version von Windows NT „Windows NT 3.1“ genannt, da sie nach Windows 3.1 auf den Markt kam
und dieselbe grafische Oberfläche wie dieses verwendete. Bei Windows 7 wurde von der internen
Versionsnummer („Windows NT 6.1“) aus technischen und psychologischen Gründen abgewichen und
„Windows 9“ wurde als Produktname übersprungen (wobei die NT-Versionen 7 bis 9 ebenfalls
übersprungen wurden).

Auch werden andere Arten, Programmversionen voneinander zu unterscheiden, verwendet, da sie
leichter zu merken sind:

- Zeitangaben wie Jahreszahlen, oder in Kombination mit z. B. Monaten, beispielsweise als:
  - zweistellige Jahreszahlen, zum Beispiel: Windows *95* (1995); Microsoft Office *95* (1995);
  - vierstellige Jahreszahlen, zum Beispiel: Windows *2000*; Microsoft Office *2000;* SoftMaker
    Office *2006;*
  - Jahre und Monate, zum Beispiel: Ubuntu-Linux 6.04 (für April 2006), OPNsense 15.1 (für Januar
    2015)[5] oder Windows 10 1507 (für Juli 2015);
  - Jahre und Halbjahr, zum Beispiel: Windows 10 20H2 (für 2. Halbjahr 2020);
- alphanumerische Bezeichner, zum Beispiel: Adobe Photoshop *CS2,* Adobe Flash *MX;* Windows *XP*;
- Codenamen, zum Beispiel: Mac OS X *Panther* (seit 2016 macOS); Windows *Vista*;
- systematische Codenamen: Ubuntu verwendet zusätzlich zur Versionsnummer „Adjektiv + Tiernamen“.
  Bei jeder neuen Version wird der Buchstabe um eine Stelle im Alphabet verschoben. Auf „Bionic
  Beaver“ folgte „Cosmic Cuttlefish“.
- Die Versionsnummer von TeX nähert sich π an; die von Metafont der Eulerschen Zahl *e*.
- Der Linux-Kernel verwendet ab Version 2.6 eine Versionsnummer, die keinen Zusammenhang mit
  tatsächlichen Fortschritten aufweist.[6]
- Bei GIMP bezeichnet eine gerade zweite Ziffer (z. B. Version 2.2, 2.4, 2.6 usw.) eine stabile
  Version, während bei Entwicklerversionen die zweite Ziffer ungerade ist. Gleich ging man auch beim
  Linux-Kernel bei den Versionen von 2.0 bis 2.6 (mit den Entwicklerversionen 2.1, 2.3 und 2.5)
  vor.[7]

## Ergänzungen

Je nach Entwicklungsstadium der Software gibt es noch Ergänzungen:

**Alpha**
: während der Entwicklung der Software, sehr frühes Stadium

**Beta**
: zum Testen vorgesehen, begrenzter Anwenderkreis

**RC**
: Veröffentlichungskandidat (englisch *release candidate*, *rc*), abschließende Testversion

**Release (final)**
: endgültige Version (englisch *Release* für Veröffentlichung)

**Patch**
: auch *patchlevel*, *pl*, deutsch *Korrekturlevel*

## Einzelnachweise

1. Tom Preston-Werner: *Semantic Versioning 2.0.0*. https://semver.org/lang/de/ (deutsch, abgerufen
   2024-07-30).
2. Linda Westfall: *The Certified Software Quality Engineer Handbook*, Verlag ASQ Quality Press,
   2008, ISBN 978-0-87389-730-3, S. 509&ndash;510,
   https://books.google.de/books?id=Pn_aVZnuHLsC&pg=PA509
3. Versionsnummern in .NET (englisch),
   https://docs.microsoft.com/en-us/previous-versions/dotnet/articles/ms973869(v=msdn.10)?redirectedfrom=MSDN#managevers_topic1
4. Microsoft: *Use AssemblyVersion and AssemblyFileVersion attributes*, 2023-12-28,
   https://learn.microsoft.com/en-us/troubleshoot/developer/dotnet/framework/general/assembly-version-assembly-file-version
   (englisch, abgerufen 2024-07-30).
5. *Updates*. OPNsense documentation, https://docs.opnsense.org/manual/updates.html (englisch,
   abgerufen 2021-02-15).
6. *LKML: Linus Torvalds: Linux 4.17-rc1*, https://lkml.org/lkml/2018/4/15/201 (abgerufen
   2023-08-10).
7. Linux Kernel Organization: *Active kernel releases*. The Linux Kernel Archives,
   https://www.kernel.org/category/releases.html (englisch, abgerufen 2025-05-26). Zitat: „Does the
   odd-even number still mean anything? &ndash; A long time ago Linux used a system where odd numbers
   after the first dot indicated pre-release, development kernels (e.g. 2.1, 2.3, 2.5). This scheme
   was abandoned after the release of kernel 2.6 and these days pre-release kernels are indicated
   with ‘-rc’.“
