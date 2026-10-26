import * as fs from 'fs/promises';
import * as path from 'path';

export class TrelloRepository {
  async getCard(cardId: string, apiKey: string, apiToken: string): Promise<unknown> {
    const url = `https://api.trello.com/1/cards/${cardId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${apiToken}"`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch Trello card ${cardId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async createCard(
    idList: string,
    name: string,
    desc: string | undefined,
    pos: string | undefined,
    due: string | undefined,
    idLabels: string | undefined,
    idMembers: string | undefined,
    apiKey: string,
    apiToken: string,
  ): Promise<unknown> {
    const url = new URL('https://api.trello.com/1/cards');
    url.searchParams.append('idList', idList);
    url.searchParams.append('name', name);
    if (desc) url.searchParams.append('desc', desc);
    if (pos) url.searchParams.append('pos', pos);
    if (due) url.searchParams.append('due', due);
    if (idLabels) url.searchParams.append('idLabels', idLabels);
    if (idMembers) url.searchParams.append('idMembers', idMembers);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${apiToken}"`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create Trello card: ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  }

  async addComment(
    cardId: string,
    text: string,
    apiKey: string,
    apiToken: string,
  ): Promise<unknown> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}/actions/comments`);
    url.searchParams.append('text', text);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${apiToken}"`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to add comment to Trello card ${cardId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async attachFileToCard(
    cardId: string,
    filePath: string,
    apiKey: string,
    apiToken: string,
  ): Promise<unknown> {
    const url = `https://api.trello.com/1/cards/${cardId}/attachments`;

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('key', apiKey);
    formData.append('token', apiToken);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to attach file to Trello card ${cardId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }
}

export const trelloRepository = new TrelloRepository();
