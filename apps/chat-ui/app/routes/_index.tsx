import type { MetaFunction } from "react-router";
import { ChatProvider } from "~/providers/ChatProvider";
import { ChatInterface } from "~/components/ChatInterface";

export const meta: MetaFunction = () => {
  return [
    { title: "ThreadWise Chat" },
    { name: "description", content: "AI-powered conversational business intelligence platform" },
  ];
};

export default function Index() {
  return (
    <ChatProvider>
      <ChatInterface />
    </ChatProvider>
  );
}