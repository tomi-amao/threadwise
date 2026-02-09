# Timeline notes of development

Chose langchain and langgrah as the fundamental technology to build the app
why, main read was because it was developer friendly and flexible when wanting to use different models
Considered other options such ass [build on this]

Decided to use a monoprepo structure, will keep all the components in a repo, like the agent, frontend, extract transform and load components and others

Will use prefect as the extract, transform and load solution, as this was a simple solution for my needs

I also considered other options such as....

When building the ai agent there are many different approaches what i am considering like router, evaluator, ochestrator, multi agent etc

Understanding the core difference between an agent and a workflow, where the former it lets the LLm decide what tool to use

Understood embedding and vector stores and how they can be used for similarity searches, which is also useful for query analysis

Extracting, transforming and loading data from squarespace which holds promairly product data. This loads data in a supabase self hosted service

The ai agent is then able to generate queries against the supabase db using the SQL tooling library

To populate the database with more information which is needed to create more busiiness intelligennce and financial insights, the banking api is needed

Whether to use solution like truelayer/plaid or calling the chosen banking api directly

Trulayer offers aggragration of bank accounts allowing for better flexibility and a standard open banking schema

custom-built created asset management system, users can add assets manually, need to know how automated asset discovery works
{
'asset_id': 'equipment_001',
'asset_type': 'EQUIPMENT',
'purchase_cost': 5000.00,
'accumulated_depreciation': 1000.00,
'current_value': 4000.00,
'purchase_date': '2023-01-15'
}
learning chart of accounts and how it is used

manual entries for accounts payable and recieveable
automate the grouping of transaction and placing them in the in the correct account

moved all backend interactiors to langgraph server

Langgraph server now accepts additional custom api routes by setting the http server in the langgraph .json file for configurtion
created a vector database in supabase

will need to provide an authentication for langgraph server
Query enhancement: Modify the input question to improve retrieval quality. This can involve rewriting unclear queries, generating multiple variations, or expanding queries with additional context.
Retrieval validation: Evaluate whether retrieved documents are relevant and sufficient. If not, the system may refine the query and retrieve again.
Answer validation: Check the generated answer for accuracy, completeness, and alignment with source content. If needed, the system can regenerate or revise the answer.

Using Langgraph generative UI compared to Tool Resultins when rending UI

| Aspect                    | LangGraph Generative UI          | Tool Result Rendering         |
| ------------------------- | -------------------------------- | ----------------------------- |
| Works with create_agent() | ❌ No (tools can't push UI)      | ✅ Yes                        |
| Requires CLI bundling     | ✅ Yes (ui.tsx bundled)          | ❌ No                         |
| Component loading         | External (network request)       | Inline (already bundled)      |
| Complexity                | High (custom graph nodes needed) | Low (just parse tool output)  |
| Real-time streaming       | ✅ Yes (partial updates)         | ❌ No (renders on completion) |

Comparing LoadExternalComponent to LocalUIRenderer

| Comparison               | LoadExternalComponent                      | LocalUIRenderer (Current)                |
| ------------------------ | ------------------------------------------ | ---------------------------------------- |
| Component Location       | Colocated with agent (`ui.tsx`)            | Frontend (visualizations)                |
| Bundling                 | LangGraph CLI bundles React components     | Already bundled with your Vite/React app |
| Network Request          | Fetches component JS from LangGraph server | No extra requests – components are local |
| Requires `langgraph dev` | ✅ Yes                                     | ❌ No                                    |
| Works with any server    | ❌ Only LangGraph CLI                      | ✅ Yes (uvicorn, Docker, etc.)           |

Further improvements including adding semantic search for memories, caching requests

Changed to pinecone vector store as it enables hybrid search capability, lexical and semantic search
Additionally it includes reranking to improve document relevantcy

Check if an uploaded documents has been successfully embeded, if not add functionality to retry embed

add memories with semantic search, based on logged in user

create database funcions to calacualre common financial reports metrics

implement backend authentication

reprocess button in integration page

highlight raw events that are stuck in processing
