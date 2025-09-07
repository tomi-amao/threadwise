from typing import Dict, Any
from langgraph.runtime import Runtime
from langchain_core.messages import HumanMessage, SystemMessage

from .state import State, Context
from .settings import get_local_llm 

async def analyze_question(state: State, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Analyze the user question and determine what data is needed."""
    llm = get_local_llm()
    
    messages = [
        SystemMessage("""You are a financial data analyst. Analyze the user's question and determine:
        1. What type of financial data they need
        2. What specific queries should be run
        
        Respond with a brief analysis of what data to retrieve."""),
        HumanMessage(f"Question: {state.question}")
    ]
    
    result = await llm.ainvoke(messages)
    return {"analysis_results": result.content}

async def generate_response(state: State, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Generate final response using retrieved data."""
    llm = get_local_llm()
    
    messages = [
        SystemMessage("""You are a financial AI assistant. Use the provided data to answer the user's question.
        Be specific, use numbers from the data, and provide actionable insights."""),
        HumanMessage(f"""
        Question: {state.question}
        
        Analysis: {state.analysis_results}
        
        
        Please provide a comprehensive answer based on this information.
        """)
    ]
    
    result = await llm.ainvoke(messages)
    return {"answer": result.content}