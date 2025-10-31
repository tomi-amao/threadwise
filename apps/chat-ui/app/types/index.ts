/**
 * ThreadWise Chat Interface Types
 * 
 * Core TypeScript interfaces for the ThreadWise conversational AI platform
 * Uses LangGraph SDK types directly to avoid unnecessary conversion overhead
 * 
 * Architecture Integration:
 * - Designed for React Router frontend (port 5173) ↔ LangGraph AI Agent (port 2024)
 * - Configuration via environment variables only
 * - Compatible with Model Context Protocol (MCP) for agent memory
 */

// Re-export LangGraph SDK types for use throughout the application
export type { Message, Thread } from '@langchain/langgraph-sdk';