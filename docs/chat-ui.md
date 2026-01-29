# Chat UI Documentation

## Overview

The ThreadWise Chat UI is a modern React application built with React Router 7 that provides a conversational interface for business intelligence. It connects to the AI Agent backend via the LangGraph SDK and supports real-time streaming, generative UI components, and thread-based conversations.

## Directory Structure

```
apps/chat-ui/
├── app/
│   ├── root.tsx              # Application root with providers
│   ├── routes.ts             # Route configuration
│   ├── globals.css           # Global styles (Tailwind)
│   ├── routes/
│   │   ├── _index.tsx        # Landing page
│   │   ├── auth.tsx          # Auth layout
│   │   ├── auth.login.tsx    # Login page
│   │   ├── auth.signup.tsx   # Signup page
│   │   ├── app.tsx           # App layout (sidebar)
│   │   ├── app.chat.tsx      # Chat interface
│   │   ├── app.dashboard.tsx # Dashboard
│   │   ├── app.invoices.tsx  # Invoice management
│   │   ├── app.reports.tsx   # Financial reports
│   │   └── app.account.tsx   # Account settings
│   ├── components/
│   │   ├── ChatInterface.tsx # Main chat entry point
│   │   ├── ChatLayout.tsx    # Responsive chat layout
│   │   ├── thread/           # Thread components
│   │   ├── visualizations/   # Chart components
│   │   ├── ui/               # UI primitives
│   │   └── layout/           # Layout components
│   ├── providers/
│   │   ├── AuthProvider.tsx  # Supabase auth
│   │   ├── ChatProvider.tsx  # LangGraph integration
│   │   └── SidebarProvider.tsx
│   ├── hooks/                # Custom hooks
│   ├── lib/                  # Utilities
│   └── types/                # TypeScript types
├── package.json
├── react-router.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Route Structure

```
/ (index)              → Landing page
├── /login             → Auth login
├── /signup            → Auth signup
└── /app (layout)
    ├── /dashboard     → Business dashboard
    ├── /chat          → AI chat interface
    ├── /invoices      → Invoice management
    ├── /reports       → Financial reports
    └── /account       → User settings
```

## Core Components

### 1. ChatProvider (`providers/ChatProvider.tsx`)

The central state manager for all chat functionality using the LangGraph SDK.

**Key Features:**

- Thread management (create, select, delete)
- Message streaming with `useStream` hook
- UI message handling for generative UI
- Model selection (local/gemini)

**State Interface:**

```typescript
interface ChatContextType {
  threads: Thread[];
  currentThread: Thread | null;
  createThread: () => Promise<Thread>;
  selectThread: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (content: string, attachments?: Base64ContentBlock[]) => Promise<void>;
  refreshThreads: () => Promise<void>;
  isStreaming: boolean;
  stopGeneration: () => void;
  messages: Message[];
  setSelectedModel: (model: ModelType) => void;
  stream: StreamType;
  uiMessages: UIMessage[];
}
```

**Configuration:**

```typescript
// From environment variables
const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';
const ASSISTANT_ID = import.meta.env.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent';
```

### 2. ChatLayout (`components/ChatLayout.tsx`)

Responsive layout manager for the chat interface.

**Features:**

- Mobile-first design with overlay sidebar
- Desktop fixed sidebar layout
- Welcome screen when no thread selected
- Mobile navigation with hamburger menus

**Layout Breakpoints:**

- Mobile (< 1024px): Overlay sidebar with backdrop
- Desktop (≥ 1024px): Fixed sidebar layout

### 3. ChatArea (`components/thread/ChatArea.tsx`)

Main conversation interface.

**Components:**

- Desktop header with assistant info
- Real-time status indicators (thinking, interrupted)
- MessageList with scrolling
- MessageInput with auto-resize

### 4. Visualization Components (`components/visualizations/`)

Generative UI chart components:

| Component               | Purpose                 |
| ----------------------- | ----------------------- |
| `BarChartViz.tsx`       | Bar chart visualization |
| `PieChartViz.tsx`       | Pie chart visualization |
| `LineChartViz.tsx`      | Line/trend chart        |
| `MetricCardViz.tsx`     | Single metric display   |
| `FinancialTableViz.tsx` | Data table display      |

### 5. AuthProvider (`providers/AuthProvider.tsx`)

Supabase authentication integration.

**Features:**

- Sign up with company registration
- Sign in with email/password
- Session management
- Profile and entity fetching

**Interface:**

```typescript
interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  entity: Entity | null;
  session: Session | null;
  loading: boolean;
  signUp: (email, password, fullName, companyName) => Promise<{ error }>;
  signIn: (email, password) => Promise<{ error }>;
  signOut: () => Promise<void>;
  updateProfile: (updates) => Promise<{ error }>;
  updateEntity: (updates) => Promise<{ error }>;
  refreshProfile: () => Promise<void>;
}
```

## UI Components

### UI Primitives (`components/ui/`)

Built with Radix UI and Tailwind CSS:

- `button.tsx` - Button variants
- `input.tsx` - Text input
- `textarea.tsx` - Multi-line input
- `card.tsx` - Card container
- `avatar.tsx` - User avatar
- `tooltip.tsx` - Hover tooltips
- `skeleton.tsx` - Loading states
- `sonner.tsx` - Toast notifications

### Thread Components (`components/thread/`)

- `ThreadSidebar.tsx` - Conversation list
- `ChatArea.tsx` - Message display area
- `ContentBlocksPreview.tsx` - Rich content rendering
- `messages/MessageList.tsx` - Message container
- `messages/MessageInput.tsx` - User input

## LangGraph SDK Integration

### useStream Hook

Real-time streaming from the AI agent:

```typescript
const stream = useStream<StreamStateType>({
  apiUrl: API_URL,
  assistantId: ASSISTANT_ID,
  threadId: currentThread?.thread_id,
  onCustomEvent: event => {
    // Handle UI messages (generative UI)
    if (isUIMessage(event) || isRemoveUIMessage(event)) {
      // Process UI component events
    }
  },
});
```

### UI Message Handling

Generative UI components from the agent:

```typescript
import { uiMessageReducer, isUIMessage, UIMessage } from '@langchain/langgraph-sdk/react-ui';

// UI messages are accumulated using the reducer
const [uiMessages, setUiMessages] = useState<UIMessage[]>([]);

// On custom event from stream
onCustomEvent: event => {
  setUiMessages(prev => uiMessageReducer(prev, event));
};
```

## Styling

### Tailwind CSS 4

Configuration in `tailwind.config.ts`:

```typescript
export default {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Custom color palette
      },
    },
  },
};
```

### Global Styles

Dark mode enabled by default in `root.tsx`:

```tsx
<html lang="en" className="dark">
```

### Component Styling Pattern

Using `class-variance-authority` for variant styling:

```typescript
const buttonVariants = cva('inline-flex items-center justify-center...', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground...',
      destructive: 'bg-destructive text-destructive-foreground...',
      outline: 'border border-input bg-background...',
    },
    size: {
      default: 'h-10 px-4 py-2',
      sm: 'h-9 px-3',
      lg: 'h-11 px-8',
    },
  },
});
```

## Environment Variables

```bash
# LangGraph API
VITE_LANGGRAPH_API_URL=http://localhost:2024
VITE_LANGGRAPH_ASSISTANT_ID=threadwise-financial-agent

# Supabase
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Development

### Running Locally

```bash
cd apps/chat-ui

# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Or from root
pnpm dev:react-router
```

### Building

```bash
pnpm build     # Production build
pnpm typecheck # TypeScript validation
```

### Dev Server

- Port: 5173 (development)
- Hot Module Replacement (HMR) enabled
- SSR with React Router 7

## Dependencies

### Production

```json
{
  "react": "^19.1.0",
  "react-router": "^7.5.3",
  "@langchain/langgraph-sdk": "^1.0.0",
  "@supabase/supabase-js": "^2.57.2",
  "@nivo/bar": "^0.99.0",
  "@nivo/pie": "^0.99.0",
  "@nivo/line": "^0.99.0",
  "lucide-react": "^0.468.0",
  "phosphor-react": "^1.4.1",
  "tailwind-merge": "^2.6.0"
}
```

### Dev Dependencies

```json
{
  "@react-router/dev": "^7.5.3",
  "tailwindcss": "^4.1.4",
  "typescript": "^5.8.3",
  "vite": "^6.3.3"
}
```

## File Attachments

The chat supports file uploads:

```typescript
interface Base64ContentBlock {
  type: 'file' | 'image';
  data: string;
  mime_type: string;
  filename?: string;
}

// Usage in sendMessage
await sendMessage('Process this invoice', [
  {
    type: 'file',
    data: base64Data,
    mime_type: 'application/pdf',
    filename: 'invoice.pdf',
  },
]);
```

## Troubleshooting

### Common Issues

1. **Stream not connecting**
   - Check `VITE_LANGGRAPH_API_URL`
   - Verify AI Agent is running
   - Check CORS configuration

2. **Auth not working**
   - Verify Supabase credentials
   - Check client initialization

3. **Styling issues**
   - Clear `.react-router/` cache
   - Rebuild Tailwind

4. **Type errors**
   - Run `pnpm typecheck`
   - Check React Router types generated
