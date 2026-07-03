export interface GiteaPRResponse {
  id: number;
  number: number;
  url: string;
  html_url: string;
  title: string;
  state: string;
}

export interface GiteaReviewResponse {
  id: number;
  user: {
    login: string;
  };
  body: string;
  state: string;
  html_url: string;
}
