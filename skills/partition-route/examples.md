# Example: astroturfed CRM activity generation

Repo: `mrtron/astroturfed`. One wrapper
(`backend/app/integrations/openrouter.py`) sends
`astroturfed/crm-activity-generation` for five prompt builders in
`backend/app/ai/tools.py`. `agent.py` already branches on `ActivityType`
before the call.

| Cluster | Methods / cases | Contract |
|---|---|---|
| `astroturfed/crm-email` | `generate_email_content` | Code-consumed `SUBJECT:` / `BODY:` parse; only critical cases |
| `astroturfed/crm-notes` | call + meeting + internal note | Human-read prose, same scorer layer |
| `astroturfed/crm-task` | `generate_task_description` | Human-read, shorter, different `max_tokens` |

That is a 3-way split, not five routes. Email must split. Keep task with notes
if Phase 1 evidence says they fail and pass together.

Call-site patch: pass `model=` from each `ActivityAITools` method into
`generate_text`. Do not change `DEFAULT_MODEL` until the parent is archived.

Incumbent for each child: the parent's current best or original
(`x-ai/grok-4.3` at first onboard). After children have production evidence,
archive `astroturfed/crm-activity-generation`.
