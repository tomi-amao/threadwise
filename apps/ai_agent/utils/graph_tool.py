"""
Graph generation tool for creating data visualizations from query results.

This tool returns structured JSON that the frontend renders as interactive charts.
The frontend detects the tool name and parses the JSON output to render Nivo charts.
"""

from langchain.tools import tool
from typing import Literal
import json


@tool
def generate_graph(
    data: list[tuple[str, float]] | list[dict],
    chart_type: Literal["bar", "line", "pie", "table"] = "bar",
    title: str = "Data Visualization",
    format: Literal["currency", "number", "percentage"] = "number"
) -> str:
    """
    Generate an interactive data visualization from query results.
    
    Use this tool to visualize financial data, metrics, or any numerical results.
    The tool automatically creates beautiful charts that are displayed to the user.
    
    Args:
        data: List of tuples (label, value) or list of dicts with 'label' and 'value' keys
              Example: [("Revenue", 60.0), ("Expenses", 20.0), ("Net Income", 40.0)]
              Or: [{"label": "Revenue", "value": 60.0}, {"label": "Expenses", "value": 20.0}]
        chart_type: Type of chart to generate - "bar", "line", "pie", or "table"
        title: Title for the visualization
        format: How to format numbers - "currency" for $, "number" for plain numbers, "percentage" for %
    
    Returns:
        JSON string with chart configuration that the frontend renders
    
    Examples:
        # Bar chart for comparing values
        generate_graph(
            data=[("Q1", 50000), ("Q2", 75000), ("Q3", 60000)],
            chart_type="bar",
            title="Quarterly Revenue",
            format="currency"
        )
        
        # Pie chart for showing distribution
        generate_graph(
            data=[("Salaries", 100000), ("Rent", 20000), ("Marketing", 15000)],
            chart_type="pie",
            title="Expense Distribution",
            format="currency"
        )
    """
    
    # Normalize data to dict format
    normalized_data = []
    if data and isinstance(data[0], tuple):
        normalized_data = [
            {
                "id": f"item_{i}",
                "label": str(item[0]),
                "value": float(item[1])
            }
            for i, item in enumerate(data)
        ]
    elif data and isinstance(data[0], dict):
        normalized_data = [
            {
                "id": item.get("id", f"item_{i}") if isinstance(item, dict) else f"item_{i}",
                "label": str(item.get("label", item.get("name", f"Item {i}"))) if isinstance(item, dict) else f"Item {i}",
                "value": float(item.get("value", 0)) if isinstance(item, dict) else 0
            }
            for i, item in enumerate(data)
        ]
    else:
        return json.dumps({
            "__chart__": True,
            "error": "Data format not recognized. Please provide list of tuples or dicts."
        })
    
    if not normalized_data:
        return json.dumps({
            "__chart__": True,
            "error": "No data provided to visualize."
        })
    
    # Build chart configuration for frontend
    chart_config = {
        "__chart__": True,  # Marker for frontend to detect chart data
        "type": chart_type,
        "title": title,
        "format": format,
        "data": normalized_data
    }
    
    # Add type-specific configurations
    if chart_type == "line":
        # Convert to line chart format (series with x/y points)
        chart_config["data"] = [{
            "id": "Series",
            "data": [
                {"x": item["label"], "y": item["value"]}
                for item in normalized_data
            ]
        }]
    
    elif chart_type == "table":
        # Convert to table format
        chart_config["headers"] = ["Item", "Value"]
        chart_config["rows"] = [
            {
                "label": item["label"],
                "values": [item["value"]],
                "isTotal": False
            }
            for item in normalized_data
        ]
    
    return json.dumps(chart_config)


@tool  
def generate_metric_card(
    title: str,
    value: float,
    format: Literal["currency", "number", "percentage"] = "currency",
    trend_direction: Literal["up", "down", "neutral"] | None = None,
    trend_value: float | None = None,
    trend_period: str | None = None,
    description: str | None = None
) -> str:
    """
    Generate a metric card to highlight a key performance indicator (KPI).
    
    Use this to showcase important numbers like total revenue, net income, 
    profit margin, or any other key metric.
    
    Args:
        title: Name of the metric (e.g., "Total Revenue", "Net Income")
        value: The metric value
        format: How to format the number - "currency", "number", or "percentage"
        trend_direction: Optional trend indicator - "up", "down", or "neutral"
        trend_value: Optional percentage change (e.g., 15.5 for 15.5% increase)
        trend_period: Optional period description (e.g., "vs last quarter")
        description: Optional additional context
    
    Returns:
        JSON string with metric card configuration that the frontend renders
        
    Example:
        generate_metric_card(
            title="Total Revenue",
            value=125000,
            format="currency",
            trend_direction="up",
            trend_value=15.5,
            trend_period="vs last month",
            description="Strong growth in product sales"
        )
    """
    
    trend = None
    if trend_direction and trend_value is not None:
        trend = {
            "direction": trend_direction,
            "value": trend_value,
            "period": trend_period or ""
        }
    
    metric_config = {
        "__chart__": True,  # Marker for frontend to detect chart data
        "type": "metric",
        "title": title,
        "value": value,
        "format": format,
    }
    
    if trend:
        metric_config["trend"] = trend
    
    if description:
        metric_config["description"] = description
    
    return json.dumps(metric_config)


# Export tools
__all__ = ["generate_graph", "generate_metric_card"]
