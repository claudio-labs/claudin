# Provider cassettes

HTTP exchanges recorded against the real providers, replayed by
`src/providers/__testutils__/cassetteServer.ts`. They are the evidence for the
wires no maintainer account reaches: the OpenAI and Azure Responses API, the
MiniMax, Moonshot and DashScope Anthropic endpoints, and Bedrock Converse.

They come from opencode's recordings
(`packages/ai/test/fixtures/recordings/` at `449c128a5b`), copied as they are
except for one change: the Azure resource host is replaced by
`example-resource`. Request headers were already scrubbed by the recorder, so
the cassettes say nothing about auth.

A cassette proves two things: Claudin parses that provider's real response
bytes, and the request fields Claudin sends are ones the provider accepted. It
does not prove byte equality with opencode's request.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
