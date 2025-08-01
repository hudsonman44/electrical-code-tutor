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

    // Get the latest user message for AutoRAG query
    const latestUserMessage = messages.filter(msg => msg.role === "user").pop();
    
    if (!latestUserMessage) {
      return new Response(
        JSON.stringify({ error: "No user message found" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Use AutoRAG to get enhanced response with electrical code context
    const ragResponse = await env.AI.autorag("electrical-code-rag").aiSearch({
      query: latestUserMessage.content,
      rewrite_query: true,
      max_num_results: 5,
      ranking_options: {
        score_threshold: 0.3,
      },
      stream: true,
    });

    // Transform AutoRAG streaming response to match frontend expectations
    if (ragResponse.body) {
      // Create a new ReadableStream to transform the response
      const transformedStream = new ReadableStream({
        start(controller) {
          const reader = ragResponse.body!.getReader();
          const decoder = new TextDecoder();
          
          const pump = async (): Promise<void> => {
            try {
              const { done, value } = await reader.read();
              
              if (done) {
                controller.close();
                return;
              }
              
              // Decode the chunk
              const chunk = decoder.decode(value, { stream: true });
              
              // Process SSE chunks from AutoRAG
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.trim() && !line.startsWith('data: [DONE]')) {
                  try {
                    // Parse AutoRAG SSE format
                    const cleanLine = line.replace(/^data: /, '').trim();
                    if (cleanLine) {
                      const data = JSON.parse(cleanLine);
                      
                      // Transform to expected frontend format
                      if (data.response) {
                        const transformedData = JSON.stringify({ response: data.response });
                        controller.enqueue(new TextEncoder().encode(transformedData + '\n'));
                      }
                    }
                  } catch (e) {
                    // Skip invalid JSON lines
                    continue;
                  }
                }
              }
              
              // Continue reading
              return pump();
            } catch (error) {
              controller.error(error);
            }
          };
          
          pump();
        }
      });
      
      return new Response(transformedStream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // Fallback if no streaming body
    return new Response(
      JSON.stringify({ error: "No response received from AutoRAG" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
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
