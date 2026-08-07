# AMAN Search

AI-powered web search app using a Netlify Function and the OpenAI Responses API with Web Search.

## Required production environment variable

In Netlify, open **Project configuration → Environment variables → Add a variable** and add:

| Key | Value | Scopes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Your OpenAI API key | Production, Deploy Previews, Branch deploys |

Do not add the key to this repository, `index.html`, or any frontend file. After saving the variable, use **Deploys → Trigger deploy → Deploy site**.

The frontend calls `/.netlify/functions/search`; only the Netlify function reads the secret and calls `https://api.openai.com/v1/responses`.

## Before sharing publicly

Configure a request-rate rule for `/.netlify/functions/search` in Netlify's security controls. This limits abusive automated requests and protects your OpenAI usage. The API key remains server-side regardless.
