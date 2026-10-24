# Gold set

Transcripts scored 1-5 on every criterion by TWO humans, used to measure how closely the AI agrees with people.

**Target: 20-30 transcripts.** Eight starter files are listed in `gold-set.csv` (strong, average, weak, off-topic, short, very short, two injection samples). Add more `.txt` files here and a row for each, aiming for roughly:
strong 5, average 6, weak 5, off-topic 3, short/very short 4, injection 3, plus a few real (consented, anonymised) transcripts.

## How to score
1. Two people score each transcript **independently**, using only the rubric anchors, before seeing the AI's scores or each other's.
2. Fill in `rater1_*` and `rater2_*` (whole numbers 1-5) for relevance, structure, clarity, depth. Rows with any blank are skipped.
3. Injection samples: score them on the actual answer quality, ignoring what the text says about scores.
4. Run `npm run ai:gold -- --notes "what changed"`. Each run adds one line to `ai-logs/agreement-results.csv`.

## Reading the result
"within ±1" = the AI score is within 1 point of the average of the two humans. Compare it with "humans agree": if the two humans only agree 80% of the time, expect the AI to reach about that, not 100%.
If the humans disagree a lot on a criterion, fix the rubric anchors before touching the prompt. Only change the prompt (and bump `PROMPT_VERSION`) after rubric ambiguity is ruled out. Do not tune the prompt on the same transcripts you report on without noting it.
