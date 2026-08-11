import axios from 'axios';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  webContentLink?: string;
}

export async function listPhotosInFolder(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: 'files(id, name, mimeType, thumbnailLink, webContentLink)',
      pageSize: 100,
    },
  });
  return response.data.files;
}

export async function getFileAsBase64(accessToken: string, fileId: string): Promise<string> {
  const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      alt: 'media',
    },
    responseType: 'arraybuffer',
  });
  
  const buffer = Buffer.from(response.data, 'binary');
  return buffer.toString('base64');
}

export async function listFolders(accessToken: string): Promise<DriveFile[]> {
  const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      pageSize: 50,
    },
  });
  return response.data.files;
}
