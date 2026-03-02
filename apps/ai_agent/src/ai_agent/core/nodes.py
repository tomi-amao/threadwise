"""Node functions for the agent graph.

Contains individual node implementations for the financial agent graph.
"""

from typing import Dict, Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from .state import State, Context
from .config import get_local_llm


async def analyze_question(state: State, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Analyze the user question and determine what data is needed.
    
    Args:
        state: Current agent state with the user's question
        runtime: Agent runtime with context
        
    Returns:
        Dict with analysis_results field containing the analysis
    """
    llm = get_local_llm()
    
    messages = [
        SystemMessage(
            """You are a financial data analyst. Analyze the user's question and determine:
            1. What type of financial data they need
            2. What specific queries should be run
            
            Respond with a brief analysis of what data to retrieve."""
        ),
        HumanMessage(f"Question: {state.question}")
    ]
    
    result = await llm.ainvoke(messages)
    return {"analysis_results": result.content}


async def generate_response(state: State, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Generate final response using retrieved data.
    
    Args:
        state: Current agent state with question and analysis results
        runtime: Agent runtime with context
        
    Returns:
        Dict with answer field containing the final response
    """
    llm = get_local_llm()
    
    messages = [
        SystemMessage(
            """You are a financial AI assistant. Use the provided data to answer the user's question.
            Be specific, use numbers from the data, and provide actionable insights."""
        ),
        HumanMessage(
            f"""Question: {state.question}
            
            Analysis: {state.analysis_results}
            
            Please provide a comprehensive answer based on this information."""
        )
    ]
    
    result = await llm.ainvoke(messages)
    return {"answer": result.content}
