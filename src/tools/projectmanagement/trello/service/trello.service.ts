import { trelloRepository } from '../repository/trello.repository.js';

export async function getTrelloCard(
  cardId: string,
  apiKey?: string,
  apiToken?: string,
): Promise<unknown> {
  const finalKey = apiKey || process.env.TRELLO_API_KEY;
  const finalToken = apiToken || process.env.TRELLO_API_TOKEN;

  if (!finalKey || !finalToken) {
    throw new Error(
      'Trello apiKey and apiToken are required. Provide them as arguments or set TRELLO_API_KEY and TRELLO_API_TOKEN.',
    );
  }

  return await trelloRepository.getCard(cardId, finalKey, finalToken);
}

export async function createTrelloCard(
  idList: string,
  name: string,
  desc?: string,
  pos?: string,
  due?: string,
  idLabels?: string,
  idMembers?: string,
  apiKey?: string,
  apiToken?: string,
  attachmentPaths?: string[],
): Promise<unknown> {
  const finalKey = apiKey || process.env.TRELLO_API_KEY;
  const finalToken = apiToken || process.env.TRELLO_API_TOKEN;

  if (!idList || !name) {
    throw new Error('Trello idList and name are required to create a card.');
  }

  if (!finalKey || !finalToken) {
    throw new Error(
      'Trello apiKey and apiToken are required. Provide them as arguments or set TRELLO_API_KEY and TRELLO_API_TOKEN.',
    );
  }

  const card = await trelloRepository.createCard(
    idList,
    name,
    desc,
    pos,
    due,
    idLabels,
    idMembers,
    finalKey,
    finalToken,
  );

  if (attachmentPaths?.length) {
    for (const filePath of attachmentPaths) {
      await trelloRepository.attachFileToCard(
        (card as Record<string, unknown>).id as string,
        filePath,
        finalKey,
        finalToken,
      );
    }
  }
  return card;
}

export async function addTrelloComment(
  cardId: string,
  text: string,
  apiKey?: string,
  apiToken?: string,
  attachmentPaths?: string[],
): Promise<unknown> {
  const finalKey = apiKey || process.env.TRELLO_API_KEY;
  const finalToken = apiToken || process.env.TRELLO_API_TOKEN;

  if (!cardId || !text) {
    throw new Error('Trello cardId and text are required to add a comment.');
  }

  if (!finalKey || !finalToken) {
    throw new Error(
      'Trello apiKey and apiToken are required. Provide them as arguments or set TRELLO_API_KEY and TRELLO_API_TOKEN.',
    );
  }

  if (attachmentPaths?.length) {
    for (const filePath of attachmentPaths) {
      await trelloRepository.attachFileToCard(cardId, filePath, finalKey, finalToken);
    }
  }
  return await trelloRepository.addComment(cardId, text, finalKey, finalToken);
}

export async function addTrelloAttachment(
  cardId: string,
  filePath: string,
  apiKey?: string,
  apiToken?: string,
): Promise<unknown> {
  const finalKey = apiKey || process.env.TRELLO_API_KEY;
  const finalToken = apiToken || process.env.TRELLO_API_TOKEN;

  if (!cardId || !filePath) {
    throw new Error('Trello cardId and filePath are required to add an attachment.');
  }

  if (!finalKey || !finalToken) {
    throw new Error(
      'Trello apiKey and apiToken are required. Provide them as arguments or set TRELLO_API_KEY and TRELLO_API_TOKEN.',
    );
  }

  return await trelloRepository.attachFileToCard(cardId, filePath, finalKey, finalToken);
}
