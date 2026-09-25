# Compare a shipped change

Open a shipped opportunity, capture stored observations for its review window, and open the comparison report. Hearsay uses the saved baseline and review snapshots. Reading the report does not call a provider, change a schedule, or write a review decision.

The default report uses every prompt in the saved benchmark for the selected intents. Each prompt has one fixed weight, regardless of how many successful repeats it has. Hearsay computes each prompt's rate from its valid answers, then averages those prompt rates. It shows raw counts and a Wilson interval for each prompt. These intervals describe individual prompt rates; they are not a test of the intervention's effect.

If either window lacks a comparable answer for a required prompt, the full benchmark reports `insufficient_data`. You can explicitly choose **Common subset** to compare only prompts with answers on both sides. That report lists every dropped prompt and has its own scope. It does not replace the full benchmark result. A window with valid answers and zero brand mentions has a rate of zero; a window with no valid answers has no rate.

The report separates observed search queries, retrieved or reported sources, and final-answer citations. Each layer shows response incidence, IDs, and metadata coverage for both windows. Different numbers of attempts, missing query metadata, and source coverage changes remain visible. Query changes describe the captured panel; they do not show customer search demand or explain a search engine's ranking.

An execution profile, benchmark, analysis revision, or observed model change can make windows incomparable. The report lists variants outside the selected series and other shipped actions on the same intent. It records both data cutoffs and correction cutoffs. Later corrections do not rewrite a saved review; capture again and make a new review if you want a later view.

The labels `observed_increase`, `observed_decrease`, and `observed_no_difference` describe arithmetic only. `insufficient_data` and `incomparable` explain why a comparison cannot be read as a complete trend. You can save your own `promising`, `not_useful`, or `inconclusive` judgment with a rationale. Hearsay never assigns that judgment automatically. Publication time does not prove indexing time; the observation delay is a user-selected window boundary.

New measurement series do not create urgent recommendation or mention-drop alerts from small samples. Collection failures can create a **Measurement incomplete** health alert. Historical alerts remain visible as legacy records.
