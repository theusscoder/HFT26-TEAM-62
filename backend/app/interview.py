"""Leading-question detector. Loftus and Palmer (1974) showed that the verb in a question shifts a witness's speed
estimate ("smashed" against "hit"). This flags the wording of questions in a transcript (lines starting Q:), as a
prompt to ask again neutrally. It says nothing about the witness."""
import re

LOADED = {
    "smashed": "hit", "smash": "hit", "slammed": "hit", "slam": "hit", "crashed": "hit", "rammed": "hit",
    "collided": "contacted", "bumped": "contacted", "speeding": "moving", "racing": "moving", "flew": "moved",
    "reckless": "(omit)", "ran the red": "went through the junction", "jumped the signal": "went through the junction",
    "obviously": "(omit)", "clearly": "(omit)", "surely": "(omit)",
    "wasn't it": "(open)", "didn't it": "(open)", "isn't it": "(open)", "the broken": "any broken", "the stolen": "any stolen",
}
QUESTION = re.compile(r"^\s*(?:Q|Question|Officer|Interviewer)\s*[:.\-]\s*(.+)$", re.I | re.M)
TERMS = re.compile(r"\b(" + "|".join(re.escape(t) for t in sorted(LOADED, key=len, reverse=True)) + r")\b", re.I)


def detect(witness: str, transcript: str) -> list[dict]:
    flags = []
    for m in QUESTION.finditer(transcript):
        question = m.group(1).strip()
        start = transcript.index(question, m.start(1))
        for term in TERMS.finditer(question):
            word = term.group(1).lower()
            fix = LOADED[word]
            suggestion = ("Ask an open question instead." if fix == "(open)" else "Leave this word out." if fix == "(omit)"
                          else f'Try "{fix}" instead of "{word}".')
            flags.append({"witness": witness, "question": question, "ref": f"{witness}.txt#c={start}-{start + len(question)}", "term": word,
                          "suggestion": suggestion, "note": f'"{word}" in the question may have shaped the answer (Loftus & Palmer, 1974). Consider a neutral follow-up.'})
    return flags
