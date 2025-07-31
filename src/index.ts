/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// System prompt for NEC 2017 electrical code expertise
const SYSTEM_PROMPT =
  "You are an expert electrical code tutor specializing in the National Electrical Code (NEC) 2017. You provide accurate, detailed explanations of electrical code requirements, safety practices, and installation standards. Always reference specific NEC sections when applicable and prioritize safety in your responses.";

export default {
  /**
   * Main request handler for the Worker
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    // Parse JSON request body
    const { messages = [] } = (await request.json()) as {
      messages: ChatMessage[];
    };

    // Get the latest user message for RAG context retrieval
    const latestUserMessage = messages.filter(msg => msg.role === "user").pop();
    
    let enhancedMessages = [...messages];
    
    // If there's a user message, get relevant context from RAG
    if (latestUserMessage) {
      try {
        // Use auto-RAG to get relevant electrical code context
        const ragResponse = await env.ELECTRICAL_CODE_RAG.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content: "You are retrieving relevant NEC 2017 electrical code information to help answer the user's question. Provide specific code sections and safety requirements."
              },
              {
                role: "user",
                content: latestUserMessage.content
              }
            ],
            max_tokens: 512,
          }
        );
        
        // If we have RAG context, add it to the conversation
        if (ragResponse && (ragResponse as any).response) {
          const contextMessage: ChatMessage = {
            role: "system",
            content: `Relevant NEC 2017 context: ${(ragResponse as any).response}`
          };
          enhancedMessages.push(contextMessage);
        }
      } catch (ragError) {
        console.warn("RAG lookup failed, proceeding without context:", ragError);
      }
    }

    // Add system prompt if not present
    if (!enhancedMessages.some((msg) => msg.role === "system")) {
      enhancedMessages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const response = await env.AI.run(
      MODEL_ID,
      {
        messages: enhancedMessages,
        max_tokens: 1024,
      },
      {
        returnRawResponse: true,
        // Uncomment to use AI Gateway
        // gateway: {
        //   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
        //   skipCache: false,      // Set to true to bypass cache
        //   cacheTtl: 3600,        // Cache time-to-live in seconds
        // },
      },
    );

    // Return streaming response
    return response;
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
