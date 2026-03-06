const BREAKER = `http://127.0.0.1:${process.env.CIRCUITBREAKER_PORT || "4243"}`;
const CIRCUIT_ID = process.env.AWS_LAMBDA_FUNCTION_NAME || "default";

export const handler = async () => {
  // 1. Check circuit
  const { allowed } = await fetch(`${BREAKER}/circuit/${CIRCUIT_ID}`).then(r => r.json());
  if (!allowed) {
    return { statusCode: 503, body: JSON.stringify({ error: "Circuit OPEN" }) };
  }

  // 2. Call downstream
  try {
    const resp = await fetch("https://official-joke-api.appspot.com/random_joke");
    if (!resp.ok) throw new Error(`Joke API returned ${resp.status}`);
    const joke = await resp.json();

    // 3. Record success
    await fetch(`${BREAKER}/circuit/${CIRCUIT_ID}/success`, { method: "POST" });
    return { statusCode: 200, body: JSON.stringify(joke) };
  } catch (err) {
    // 3. Record failure
    await fetch(`${BREAKER}/circuit/${CIRCUIT_ID}/failure`, { method: "POST" });
    return { statusCode: 503, body: JSON.stringify({ error: err.message }) };
  }
};
