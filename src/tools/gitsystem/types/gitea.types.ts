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

export interface GiteaPRDetail {
  number: number;
  html_url: string;
  mergeable: boolean;
  head: {
    sha: string;
  };
}

export interface GiteaCombinedStatus {
  state: 'pending' | 'success' | 'error' | 'failure';
  statuses: Array<{ context: string; status: string; description: string }>;
}
