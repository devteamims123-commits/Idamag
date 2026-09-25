// PostgreSQL persistence is handled by chatbotRoutes.js. This map only keeps
// the active request's state available to that route and chatbotService.
const conversations = new Map();

function getConversation(key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("A conversation key is required.");
  }

  if (!conversations.has(key)) {
    conversations.set(key, { history: [] });
  }

  return conversations.get(key);
}

function clearConversation(key) {
  conversations.delete(key);
}

module.exports = { getConversation, clearConversation };
