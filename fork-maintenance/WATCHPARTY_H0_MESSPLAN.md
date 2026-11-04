# H0 – Messplan: Verhalten der Watch Party beim Ausfall des Hosts

Ziel: das tatsächliche Verhalten des offiziellen Nuvio-Backends und der Clients messen, **bevor** H1 (Sync-Failover) gebaut wird. Es wird nichts am Code geändert. Gemessen wird mit der aktuellen Test-MSI (0.1.47) bzw. einer späteren, und der Preview.

## Aufbau

| Rolle | Gerät | Konto |
|---|---|---|
| **H** (Host) | Desktop 1, NUVIO | Konto 1 |
| **D** (Desktop-Gast) | Desktop 2, NUVIO | Konto 2 |
| **B** (Browser-Gast) | Browser, Preview | Konto 3 |
| **N** (neuer Gast, nur M7) | zweiter Browser oder privates Fenster | Konto 4 |

**Vorbereitung:**
- Film mit einer Quelle, die bei allen läuft; am einfachsten eine öffentliche HLS-Testquelle als „Eigener Video-Link“, damit TorBox die Messung nicht verfälscht.
- **Browser-Diagnose einschalten:** In der Browser-Konsole von B `sessionStorage.setItem('nuvio-party-debug','1')` eingeben und die Seite neu laden. Unter „Technik“ erscheinen dann unter anderem:
  - `realtime`, `realtimeLog` (Verbindungsprotokoll mit Zeitstempeln)
  - `lastCandidateSeq`, `hostPaused`, `hostPositionSeconds`, `driftSeconds`, `syncActive`
- **Uhr:** Die Zeiten mit einer Stoppuhr ab dem Ausfall messen. Die Desktop-App schreibt im installierten Zustand keine lesbare Logdatei; beobachtet wird dort das Party-Panel (Host-Kennzeichen, Status, Online-Punkt).
- **Notiert werden nur** Zeiten, Statustexte, Host-Kennzeichen und Diagnosewerte, keine Links oder Tokens.

**Ausgangslage vor jedem Fall:**
- H ist Host, D und B sind beigetreten, der Film läuft synchron (alle „Synchron“).
- Pro Fall einmal mit „Only I can control playback“ **aus** und einmal **an** messen.

## Messfälle

Für jeden Fall bei 0 s, 10 s, 30 s, 60 s, 2 min und 5 min notieren:
- **D:** Wer ist Host? Spielt der Film weiter? Status-Text?
- **B:** `syncActive`, `driftSeconds`, `lastCandidateSeq`, `hostPaused`, Chip „Synchron“/„Allein“, Meldungen.
- **Wann wechselt das Host-Kennzeichen**, und zu wem?
- **Endet die Party** für D oder B, und mit welcher Meldung?

| Nr. | Ausfall bei H | Durchführung |
|---|---|---|
| **M1** | Freiwilliges „Leave party“ | Im Party-Menü „Leave party“. |
| **M2** | NUVIO vollständig schließen | Fenster schließen bzw. Task beenden. |
| **M3** | PC aus | Desktop 1 hart ausschalten oder Stecker ziehen (bzw. Ruhezustand). |
| **M4** | Netzverlust | WLAN aus bzw. LAN-Kabel ziehen; NUVIO bleibt offen. |
| **M5** | Host kommt zurück | Nach M4 nach 1 min wieder verbinden, bzw. nach M2 neu starten und über den Einladungslink beitreten. Wird H wieder Host? Springt der Stand bei D oder B? |
| **M6** | Gleichzeitiger Ausfall | H und D gleichzeitig trennen (M4 bei beiden), dann D zuerst zurück, kurz danach H. Gibt es zwei verschiedene Stände (Diagnose `lastCandidateSeq` springt hin und her)? |
| **M7** | Neuer Gast ohne Host | Nach M2: N tritt über den Einladungslink bei. Bekommt N eine Quelle? Welche Meldung erscheint? |
| **M8** | Pause ohne Host | Nach M2 bei D Pause drücken (Host-only aus bzw. an). Folgt B? Bleibt es pausiert? |
| **M9** | End for everyone | Normal: H beendet für alle. Endet die Party bei D und B sofort? |
| **M10** | TorBox ohne Host (optional) | Familienfreigabe aktiv, B spielt den TorBox-Stream; dann H aus (M3). Wie lange spielt B weiter? Bekommt ein Reload bei B nach 30 min noch eine Quelle? |

## Auswertung

Pro Fall eine Zeile:

| Fall | Host-only | Host-Wechsel nach | neuer Host | D spielt weiter | B im Sync | Party endet | Auffälligkeiten |
|---|---|---|---|---|---|---|---|

Daraus werden diese H1-Parameter abgeleitet:
- die **Presence-Schwelle** (wie schnell Realtime einen Abbruch meldet)
- ob das Backend bei Abbrüchen überhaupt den Host wechselt
- ob ein Desktop-Gast bei „Host only“ den Stand speichern darf (M8 mit Host-only an)
- ob Browser beim Host-Wechsel aus dem Sync fallen (erwartet: ja, „Allein“)
- wie lange TorBox-Adressen ohne Erneuerung halten (M10)

**Abbruchkriterium:** Bricht bei einem Fall die Wiedergabe für alle ab, oder erscheinen sicherheitsrelevante Daten (Tokens) in einer Meldung, dann nur Fallnummer und Beobachtung notieren und mir melden.
