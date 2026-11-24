export const gitEndpoint = 'https://github.com/joomengine/skills.git/info/refs?service=git-upload-pack';
export const apiEndpoint = 'https://api.github.com/repos/joomengine/skills/commits/HEAD';

// Match GitHub's smart HTTP service header, flush, HEAD with capabilities, real ref and final flush.
export function gitAdvertisement(revision, firstRef = 'HEAD') {
  const packet = data => (Buffer.byteLength(data) + 4).toString(16).padStart(4, '0') + data;
  return packet('# service=git-upload-pack\n') + '0000' +
    packet(revision + ' ' + firstRef + '\0multi_ack symref=HEAD:refs/heads/release object-format=sha1\n') +
    packet(revision + ' refs/heads/release\n') + '0000';
}
