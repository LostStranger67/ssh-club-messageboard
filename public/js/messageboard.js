// js/messageboard.js

/**
 * Returns an SVG icon string based on the media type.
 * 'currentColor' allows us to set the color with CSS.
 * @param {string} mediaType - Can be 'image', 'video', or 'audio'.
 * @returns {string} The SVG HTML string.
 */
function getMediaIcon(mediaType) {
    const svgAttrs = `width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

    switch (mediaType) {
        case 'image':
            return `<svg ${svgAttrs}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
        case 'video':
            return `<svg ${svgAttrs}><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
        case 'audio':
            return `<svg ${svgAttrs}><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        default:
            return ''; // No icon for unknown types
    }
}

function makeTransformable(elmnt) {
    elmnt.data = 1;
    elmnt.style.transform = `scale(${elmnt.data})`;

    elmnt.style.left = "50%";
    elmnt.style.top = "50%";
    elmnt.style.transform = "translate(-50%, -50%)";

    elmnt.onwheel = function (e) {
        e.preventDefault();
        // console.log(e.wheelDelta);
        (e.wheelDelta > 0) ? (elmnt.data *= 1.1) : (elmnt.data /= 1.1);
        elmnt.data < 0.1 ? elmnt.data = 0.1 : true;
        elmnt.style.transform = `translate(-50%, -50%) scale(${elmnt.data})`;
    }

    var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    elmnt.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        // get the mouse cursor position at startup:
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        // call a function whenever the cursor moves:
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // calculate the new cursor position:
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        // set the element's new position:
        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        // stop moving when mouse button is released:
        document.onmouseup = null;
        document.onmousemove = null;
    }


}

document.addEventListener("DOMContentLoaded", () => {
    // --- State and DOM Elements ---
    let currentThreadId = null;
    let myPosts = JSON.parse(localStorage.getItem('myPosts')) || [];
    const messagesWrapper = document.getElementById('messagesWrapper');
    const sendButton = document.getElementById('sendButton');
    const messageInput = document.getElementById('messageInput');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

    // Reply preview element
    let previewElement = null;
    const replyMap = new Map(); // To store backlinks, e.g., { '123' => ['456', '789'] }

    // Modal elements
    const modal = document.getElementById('mediaDisplayModal');
    const modalImage = document.getElementById('modalImage');
    const modalVideo = document.getElementById('modalVideo');
    const modalAudio = document.getElementById('modalAudio');
    const closeModal = document.getElementById("modalClose");

    // --- Core Functions ---
    /**
        * Replaces >>ID patterns with interactive links and generates backlinks.
        */
    // Escape HTML so user-submitted text can never inject markup (stored XSS)
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function processMessageContent(msg) {
        const myPostsSet = new Set(myPosts.map(p => p.id));
        const content = msg.text;

        // Regex to find all >>ID patterns
        const replyRegex = />>(\d+)/g;

        // Escape every plain-text segment; the only markup we emit is the
        // >>ID reply anchors built below.
        let html = '';
        let lastIndex = 0;
        let match;

        while ((match = replyRegex.exec(content)) !== null) {
            html += escapeHtml(content.slice(lastIndex, match.index));

            const numId = parseInt(match[1], 10);

            // Generate backlink data
            if (!replyMap.has(numId)) {
                replyMap.set(numId, []);
            }
            replyMap.get(numId).push(msg.id);

            // Check if this is a reply to one of your posts
            const isReplyToYou = myPostsSet.has(numId);

            html += `<a href="#message-${numId}" class="reply-link ${isReplyToYou ? 'reply-to-you' : ''}" data-replied-to="${numId}">${match[0]}</a>`;
            lastIndex = match.index + match[0].length;
        }
        html += escapeHtml(content.slice(lastIndex));

        return html;
    }
    /**
     * Renders a single message and appends it to the container.
     */
    function renderMessage(msg) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'messageContainer';
        messageDiv.id = `message-${msg.id}`; // Use the new database ID

        const messageBodyDiv = document.createElement('div');
        messageBodyDiv.className = 'messageBody';

        const textDiv = document.createElement('div');
        textDiv.className = 'message';
        textDiv.innerHTML = processMessageContent(msg);

        // Add a container for backlinks
        const backlinksDiv = document.createElement('div');
        backlinksDiv.className = 'backlinks';

        const metadataDiv = document.createElement('div');
        metadataDiv.className = 'messageMetadata';
        const signatureDiv = document.createElement('div');
        signatureDiv.className = 'signature';
        signatureDiv.textContent = msg.signature;

        const hashDiv = document.createElement('span');
        const hashSpan = document.createElement('span');
        hashSpan.className = 'hash';
        hashSpan.textContent = msg.hash || '';
        hashDiv.appendChild(hashSpan);


        if (msg.signature === 'Anonymous' && msg.hash) {
            hashDiv.style.display = 'none';
        }

        signatureDiv.append(hashDiv);
        signatureDiv.addEventListener('click', () => deletePost(msg.id));

        const timestampDiv = document.createElement('div');
        timestampDiv.className = 'timestamp';
        timestampDiv.innerHTML = `
            ${new Date(msg.timestamp).toLocaleString()}
            <span class="messageId" onclick="navigator.clipboard.writeText('>>${msg.id}')" title="Copy ID">#${msg.id}</span>
        `;
        metadataDiv.append(signatureDiv, timestampDiv);

        if (msg.mediaUrl) {
            const isImage = msg.mediaUrl.match(/\.(jpg|jpeg|png|gif)$/i);
            const isVideo = msg.mediaUrl.match(/\.(mp4|webm)$/i);
            const isAudio = msg.mediaUrl.match(/\.(mp3|ogg|wav|flac)$/i);

            // Create a clickable container for the media
            const mediaLink = document.createElement('div');
            mediaLink.className = 'messageMediaThumbnail';

            let mediaType = '';
            if (isImage) mediaType = 'image';
            if (isVideo) mediaType = 'video';
            if (isAudio) mediaType = 'audio';
            const iconHTML = getMediaIcon(mediaType);

            // If a real thumbnail exists (usually for images), use it.
            if (msg.thumbnailUrl) {
                if (isVideo) {
                    // Video: Show Thumbnail + Icon Overlay
                    mediaLink.innerHTML = `<img src="${msg.thumbnailUrl}" alt="media thumbnail">${iconHTML}`;
                    mediaLink.classList.add('has-thumb'); // Triggers the CSS overlay
                } else {
                    // Image: Show ONLY Thumbnail (Clean)
                    mediaLink.innerHTML = `<img src="${msg.thumbnailUrl}" alt="media thumbnail">`;
                }
            }
            // Otherwise, show a default SVG icon.
            else {
                mediaLink.innerHTML = iconHTML;
            }

            // This onclick handler will open your custom modal instead of the new tab.
            mediaLink.onclick = (e) => {

                modalImage.style.display = 'none';
                modalVideo.style.display = 'none';
                // Note: I'm assuming you have a modalAudio element for your modal
                modalAudio.style.display = 'none';

                modal.style.display = "block";

                if (isImage) {
                    modalImage.style.display = 'block';
                    modalImage.src = msg.mediaUrl;
                    makeTransformable(modalImage);

                } else if (isVideo) {
                    modalVideo.style.display = 'block';
                    modalVideo.src = msg.mediaUrl;
                    makeTransformable(modalVideo);
                } else if (isAudio) {
                    modalAudio.style.display = 'block';
                    modalAudio.src = msg.mediaUrl;
                    // For audio, maybe just open it in a new tab since it has its own controls
                    // window.open(msg.mediaUrl, '_blank');
                    // modal.style.display = "none"; // Hide modal if we opened a new tab
                }
            };

            messageBodyDiv.appendChild(mediaLink);
        }

        messageBodyDiv.appendChild(textDiv);
        messageBodyDiv.appendChild(backlinksDiv);
        messageDiv.append(metadataDiv, messageBodyDiv);
        messagesWrapper.appendChild(messageDiv);
    }

    function applyBacklinks() {
        for (const [messageId, repliers] of replyMap.entries()) {
            const targetMessage = document.getElementById(`message-${messageId}`);
            if (targetMessage) {

                const uniqueRepliers = [...new Set(repliers)];
                const backlinksContainer = targetMessage.querySelector('.backlinks');
                let backlinkHTML = '';
                uniqueRepliers.forEach(replierId => {
                    backlinkHTML += `<a href="#message-${replierId}" class="reply-link" data-replied-to="${replierId}">>>${replierId} </a>`;
                });
                backlinksContainer.innerHTML = backlinkHTML;
            }
        }
    }

    function updateBacklinksForMessage(messageId) {
        const targetMessage = document.getElementById(`message-${messageId}`);
        // Only proceed if the message we're updating is actually on the page
        if (!targetMessage) {
            return;
        }

        const backlinksContainer = targetMessage.querySelector('.backlinks');
        const repliers = replyMap.get(messageId);

        if (repliers && repliers.length > 0) {
            const uniqueRepliers = [...new Set(repliers)];
            let backlinkHTML = '';
            uniqueRepliers.forEach(replierId => {
                backlinkHTML += `<a href="#message-${replierId}" class="reply-link" data-replied-to="${replierId}">>>${replierId} </a>`;
            });
            backlinksContainer.innerHTML = backlinkHTML;
        } else {
            backlinksContainer.innerHTML = ''; // Clear it if no replies
        }
    }

    /**
     * Fetches all messages for the current thread on page load.
     */
    async function loadInitialThread() {
        try {
            const response = await fetch(`/api/thread/${currentThreadId}`);
            if (!response.ok) throw new Error('Thread not found or server error');

            const messages = await response.json();
            messagesWrapper.innerHTML = ''; // Clear loading message
            replyMap.clear();

            messages.forEach(renderMessage);
            applyBacklinks();

            scrollMessagesToBottom();
        } catch (error) {
            console.error('Failed to load thread:', error);
            messagesWrapper.innerHTML = `<h1>Error: ${error.message}</h1>`;
        }
    }

    /**
    * Handles the hover effect for reply link previews.
    */
    function initReplyPreviews() {
        messagesWrapper.addEventListener('mouseover', (e) => {
            // Ignore hovers originating inside a preview clone, otherwise
            // previews spawn nested previews forever
            if (e.target.closest('.reply-preview')) return;
            if (e.target.classList.contains('reply-link')) {
                const previewTargetId = e.target.dataset.repliedTo;
                const originalMessage = document.getElementById(`message-${previewTargetId}`);

                if (!originalMessage) return;

                // Replace any existing preview instead of stacking a new one
                if (previewElement) {
                    previewElement.remove();
                    previewElement = null;
                }

                previewElement = originalMessage.cloneNode(true);
                previewElement.id = ''; // Clones should not have IDs
                previewElement.classList.add('reply-preview');

                const containerMessageElement = e.target.closest('.messageContainer');
                containerMessageElement.appendChild(previewElement);

            }
        });

        messagesWrapper.addEventListener('mouseout', (e) => {
            if (e.target.classList.contains('reply-link') && previewElement) {
                previewElement.remove();
                previewElement = null;
            }
        });
    }

    /**
     * Sends a new reply to the server.
     */
    async function sendReply() {
        const text = messageInput.value;
        const signature = document.getElementById('signatureInput').value;
        let secret = document.getElementById('secretInput').value;
        const media = document.getElementById('mediaInput').files[0];

        if (secret == "") {
            secret = makeRandomSecret();
        }

        if (!text.trimEnd() && !media) {
            alert('A message must have text or media.');
            return;
        }

        const formData = new FormData();
        formData.append('text', text.trimEnd());
        formData.append('signature', signature);
        formData.append('secret', secret);
        if (media) formData.append('media', media);

        try {
            sendButton.disabled = true;
            sendButton.textContent = 'Sending...';

            const response = await fetch(`/api/thread/${currentThreadId}/reply`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to send reply.');
            } else {
                const responseData = await response.json(); // Assuming server replies with the new message object

                // Save the new post ID to localStorage
                myPosts.push({ id: responseData.message.id, threadId: currentThreadId, secret });
                localStorage.setItem('myPosts', JSON.stringify(myPosts));
            }

            // Clear the form. The new message will appear automatically via SSE.
            messageInput.value = '';
            document.getElementById('mediaInput').value = ''; // file inputs throw SecurityError on any non-empty set
            messageInput.style.height = 'auto'; // Reset textarea height
            fileNameDisplay.textContent = '';
        } catch (error) {
            console.error('Error sending reply:', error);
            alert(`Error: ${error.message}`);
        } finally {
            sendButton.disabled = false;
            sendButton.textContent = 'Send';
        }
    }

    /**
     * Connects to the SSE endpoint to listen for new messages in real-time.
     */
    function initializeRealtimeUpdates() {
        const eventSource = new EventSource('/api/updates');

        eventSource.addEventListener('newMessage', (event) => {
            const data = JSON.parse(event.data);

            // IMPORTANT: Only render the message if it belongs to the current thread.
            if (data.threadId === currentThreadId) {
                // Check if the message is already on the page to prevent duplicates
                if (!document.getElementById(`message-${data.message.id}`)) {
                    renderMessage(data.message);

                    // 2. Find which posts this new message replied to.
                    const replyRegex = />>(\d+)/g;
                    const repliedToIds = [...data.message.text.matchAll(replyRegex)].map(match => parseInt(match[1], 10));

                    // 3. Call our new function to update the DOM for each replied-to post. ✅
                    repliedToIds.forEach(id => {
                        updateBacklinksForMessage(id);
                    });

                    scrollMessagesToBottom();
                }
            }
        });

        eventSource.onerror = (err) => {
            console.error("EventSource connection error:", err);
        };
    }

    function scrollMessagesToBottom() {
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
    }

    function makeRandomSecret() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    async function deletePost(postId) {
        // fresh read under a distinct name — shadows the outer myPosts list
        const savedPosts = JSON.parse(localStorage.getItem('myPosts')) || [];
        const entry = savedPosts.find(p => p.id === postId);
        let secret = entry?.secret || '';

        // Step 1: Confirm deletion
        const confirmDelete = confirm('Are you sure you want to delete this post?');
        if (!confirmDelete) return;

        // Step 2: Fallback if the code isn't in this browser's cache
        if (!secret) {
            secret = (prompt(
                'The signature code for this post is not saved on this device.\n' +
                'Enter the signature code you used when posting it:'
            ) || '').trim();
            if (!secret) {
                alert('Deletion cancelled — no signature code provided.');
                return;
            }
        }

        try {
            const res = await fetch(`/api/delete/${postId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret })
            });

            if (res.ok) {
                alert('✅ Post deleted successfully. You will see changes after reloading the page.');
                // Optional visual feedback:
                const el = document.getElementById(`message-${postId}`);
                if (el) el.style.opacity = '0.5';

                // Remove from cache
                localStorage.setItem('myPosts', JSON.stringify(savedPosts.filter(p => p.id !== postId)));
            } else {
                const err = await res.json();
                alert(`Failed to delete post: ${err.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error('Delete failed:', e);
            alert('An error occurred while deleting the post.');
        }
    }


    /**
     * Main initialization function.
     */
    async function init() {
        // Extract threadId from the URL (e.g., "/thread/123")
        const path = window.location.pathname;
        const match = path.match(/\/thread\/(\d+)/);

        const mediaInput = document.getElementById('mediaInput');

        mediaInput.addEventListener('change', () => {
            // Check if the user has selected a file
            if (mediaInput.files.length > 0) {
                // Get the name of the first file
                const fileName = mediaInput.files[0].name;
                // Update the span's text with the filename
                fileNameDisplay.textContent = fileName;
            } else {
                // If the user cancels the file selection, reset the text
                fileNameDisplay.textContent = '';
            }
        });

        const formContainer = document.getElementById('formInputContainer');

        // 1. Add a class when a file is dragged over the drop zone
        formContainer.addEventListener('dragover', (event) => {
            // This is crucial to allow a drop
            event.preventDefault();
            formContainer.classList.add('drag-over');
        });

        // 2. Remove the class when the file leaves the drop zone
        formContainer.addEventListener('dragleave', () => {
            formContainer.classList.remove('drag-over');
        });

        // 3. Handle the file when it is dropped
        formContainer.addEventListener('drop', (event) => {
            // This is also crucial to prevent the browser from opening the file
            event.preventDefault();
            console.log(event.dataTransfer.files)
            formContainer.classList.remove('drag-over');

            // Get the dropped files from the event
            const files = event.dataTransfer.files;

            // If a file was dropped, assign it to our hidden input
            if (files.length > 0) {
                // This is the key part: we connect the dropped file to our existing input.
                mediaInput.files = files;

                // Manually trigger the 'change' event on the input.
                // This makes our existing code that displays the filename run automatically!
                mediaInput.dispatchEvent(new Event('change'));
            }
        });

        if (!match) {
            document.body.innerHTML = "<h1>Invalid Thread URL.</h1>";
            return;
        }

        currentThreadId = parseInt(match[1], 10);

        // Setup event listeners
        sendButton.addEventListener('click', sendReply);
        closeModal.onclick = () => {
            modal.style.display = "none";
            modalImage.src = "";
            modalVideo.src = ""; // Stop video playback
            modalAudio.src = "";
        };
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = `${messageInput.scrollHeight}px`;
        });

        // --- Paste image from clipboard into media upload ---
        messageInput.addEventListener('paste', (e) => {
            const items = e.clipboardData.items;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    mediaInput.files = dt.files;
                    fileNameDisplay.textContent = file.name || 'pasted image';
                    break;
                }
            }
        });

        // Load initial data and then start listening for real-time updates
        await loadInitialThread();
        initializeRealtimeUpdates();
        initReplyPreviews();
    }

    init(); // Run the app
});