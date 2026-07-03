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
}

export const trelloRepository = new TrelloRepository();
