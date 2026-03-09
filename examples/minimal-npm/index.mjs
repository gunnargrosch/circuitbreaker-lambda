import { CircuitBreaker } from "circuitbreaker-lambda";

const breaker = new CircuitBreaker(fetchJoke, {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 10000,
});

export const handler = async () => {
  try {
    const joke = await breaker.fire();
    return { statusCode: 200, body: JSON.stringify(joke) };
  } catch (err) {
    return { statusCode: 503, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchJoke() {
  const resp = await fetch("https://official-joke-api.appspot.com/random_joke");
  if (!resp.ok) throw new Error(`Joke API returned ${resp.status}`);
  return resp.json();
}
