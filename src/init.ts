import Bottleneck from "bottleneck";
import axios, { AxiosInstance } from "axios";
import axiosRetry, { IAxiosRetryConfig } from "axios-retry";

let limiter: Bottleneck;
let axiosInstance: AxiosInstance;
let API_KEY: string


async function fetchRateLimitFromDatabase() {
  // TODO: Implement actual database fetch
  return { rateLimit: 8, apiKey: process.env.API_KEY as string }; // Default value for now
}


const retryConfig: IAxiosRetryConfig = {
  retries: 3,
  retryDelay: (retryCount, error) => {
    limiter.schedule(() => Promise.resolve());
    if (error.response && error.response.status === 429) {
      return 1000;
    }
    return axiosRetry.exponentialDelay(retryCount);
  },
  retryCondition: async (error: any) => {
    if (error.response && error.response.status === 429) {
    }
    if (
      axiosRetry.isNetworkError(error) ||
      (error.response && error.response.status === 429)) {
      return true;
    }
    return false;
  },
};

async function initialize() {
  // TODO: Replace this with actual database fetch


  axiosInstance = axios.create({
    timeout: 300000,
  });
  const { rateLimit, apiKey } = await fetchRateLimitFromDatabase();

  limiter = new Bottleneck({
    minTime: 1 / rateLimit,
  });

  axiosRetry(axiosInstance, retryConfig);
  API_KEY = apiKey

  console.log(`Limiter initialized with rate limit: ${rateLimit} requests per second`);
}

export { limiter, initialize, axiosInstance, API_KEY };