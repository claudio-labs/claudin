Notes kept for the invoice exporter session.

# Session Title
_Rename the invoice exporter and keep its CSV byte-stable_

# Current State
The rename is done. The golden CSV still has to be regenerated.

## Open questions
- Does the finance import accept a byte order mark?

# Worklog
- Moved the exporter into its own slice.
- Ran the exporter tests: 14 pass.
- Compared the CSV with last week's export: identical.

# Learnings
Golden files are regenerated with the update flag, never edited by hand.
#hashtag lines like this one stay inside the section above.
