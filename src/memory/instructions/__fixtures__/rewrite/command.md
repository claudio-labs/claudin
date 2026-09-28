---
description: Summarise an open pull request
argument-hint: [pr-number] [--with-comments]
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Read
model: sonnet
---
Fetch pull request $ARGUMENTS and summarise what it changes, file by file.
