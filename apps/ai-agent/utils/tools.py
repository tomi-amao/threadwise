from langchain_community.utilities import SQLDatabase
from langchain_community.agent_toolkits import SQLDatabaseToolkit
from langchain_community.tools.sql_database.tool import QuerySQLDatabaseTool
from .settings import get_local_llm 
import os

model = get_local_llm()

# Get database URL from environment variable or use local development default
database_url = os.getenv("DATABASE_URL", "postgresql://postgres.your-tenant-id:your-super-secret-and-long-postgres-password@localhost:5432/postgres")

# Use psycopg2 instead of asyncpg for synchronous operations
db = SQLDatabase.from_uri(database_url)

print(db.dialect)
print(db.get_usable_table_names())

from typing_extensions import TypedDict


class State(TypedDict):
    question: str
    query: str
    result: str
    answer: str


from langchain_core.prompts import ChatPromptTemplate






def execute_query(state: State):
    """Execute SQL query."""
    execute_query_tool = QuerySQLDatabaseTool(db=db)
    return {"result": execute_query_tool.invoke(state["query"])}


def generate_answer(state: State):
    """Answer question using retrieved information as context."""
    prompt = (
        "Given the following user question, corresponding SQL query, "
        "and SQL result, answer the user question.\n\n"
        f"Question: {state['question']}\n"
        f"SQL Query: {state['query']}\n"
        f"SQL Result: {state['result']}"
    )
    response = model.invoke(prompt)
    return {"answer": response.content}

from langgraph.graph import START, StateGraph


from langgraph.checkpoint.memory import MemorySaver

memory = MemorySaver()
# graph = graph_builder.compile(checkpointer=memory, interrupt_before=["execute_query"])

# Now that we're using persistence, we need to specify a thread ID
# so that we can continue the run after review.
config = {"configurable": {"thread_id": "1"}}



from langchain_community.agent_toolkits import SQLDatabaseToolkit

# Create the toolkit that contains the tools for interacting with the database
toolkit = SQLDatabaseToolkit(db=db, llm=model)
# Get the tools
tools = toolkit.get_tools()




from langchain_core.messages import HumanMessage
from langgraph.prebuilt import create_react_agent

# agent_executor = create_react_agent(model, tools, prompt=system_message)

# question = "What is the total income of all customers in the database?"

# for step in agent_executor.stream(
#     {"messages": [{"role": "user", "content": question}]},
#     stream_mode="values",
# ):
#     step["messages"][-1].pretty_print()


# import ast
# import re

# # Utility function to run a query and return results as a list of strings that are unique and cleaned of numbers
# def query_as_list(db, query):
#     res = db.run(query)
#     res = [el for sub in ast.literal_eval(res) for el in sub if el]
#     res = [re.sub(r"\b\d+\b", "", string).strip() for string in res]
#     return list(set(res))


# artists = query_as_list(db, "SELECT Name FROM Artist")
# albums = query_as_list(db, "SELECT Title FROM Album")
# albums[:5]


# from langchain.agents.agent_toolkits import create_retriever_tool

# _ = vector_store.add_texts(artists + albums)
# retriever = vector_store.as_retriever(search_kwargs={"k": 5})
# description = (
#     "Use to look up values to filter on. Input is an approximate spelling "
#     "of the proper noun, output is valid proper nouns. Use the noun most "
#     "similar to the search."
# )
# retriever_tool = create_retriever_tool(
#     retriever,
#     name="search_proper_nouns",
#     description=description,
# )

# print(retriever_tool.invoke("Alice Chains"))

# # Add to system message
# suffix = (
#     "If you need to filter on a proper noun like a Name, you must ALWAYS first look up "
#     "the filter value using the 'search_proper_nouns' tool! Do not try to "
#     "guess at the proper name - use this function to find similar ones."
# )

# system = f"{system_message}\n\n{suffix}"

# tools.append(retriever_tool)

# agent = create_react_agent(model, tools, prompt=system)

# question = "How many albums does alis in chain have?"

# for step in agent.stream(
#     {"messages": [{"role": "user", "content": question}]},
#     stream_mode="values",
# ):
#     step["messages"][-1].pretty_print()