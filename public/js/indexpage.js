document.addEventListener("DOMContentLoaded", () => {
    // --- Grab DOM Elements ---
    const threadsContainer = document.getElementById('threadsContainer');
    const sendButton = document.getElementById('sendButton');
    const motd = document.getElementById('daily-message');

    const launchRadioBtn = document.getElementById('launchRadioBtn');
    const launchRulesBtn = document.getElementById('launchRulesBtn');
    const launchWallBtn = document.getElementById('launchWallBtn');

    const mediaInput = document.getElementById('mediaInput');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

    mediaInput.addEventListener('change', () => {
        // Check if the user has selected a file
        if (mediaInput.files.length > 0) {
            // Get the name of the first file
            const fileName = mediaInput.files[0].name;
            // Update the span's text with the filename
            fileNameDisplay.textContent = fileName;
        } else {
            // If the user cancels the file selection, reset the text
            fileNameDisplay.textContent = 'Select file...';
        }
    });

    // --- Paste image from clipboard into media upload ---
    function handleImagePaste(e) {
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
    }

    document.getElementById('messageInput').addEventListener('paste', handleImagePaste);

    // --- Core Functions ---

    /**
     * Fetches and displays the initial list of threads when the page loads.
     */
    async function loadInitialThreads() {
        try {
            const response = await fetch('/api/threads');
            if (!response.ok) throw new Error('Failed to fetch threads');

            const threads = await response.json();

            // Clear any existing content
            threadsContainer.innerHTML = '';

            // Render each thread
            threads.forEach(thread => {
                const threadElement = createThreadElement(thread);
                threadsContainer.appendChild(threadElement);
            });
        } catch (error) {
            console.error('Failed to load threads:', error);
            threadsContainer.textContent = 'Could not load threads. Please try again later.';
        }
    }

    launchRadioBtn.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
            window.open('/radio', '_blank');
        } else {
            window.location.href = '/radio';
        }
    });


    launchRulesBtn.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
            window.open('/rules.html', '_blank');
        } else {
            window.location.href = '/rules.html';
        }
    });

    launchWallBtn.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
            window.open('/graffiti.html', '_blank');
        } else {
            window.location.href = '/graffiti.html';
        }
    });

    /**
     * Creates the DOM element for a single thread preview.
     * This function is now adapted to the new, flat API response.
     */
    function createThreadElement(thread) {
        const threadDiv = document.createElement('div');
        threadDiv.className = 'threadContainer';
        threadDiv.id = `thread-${thread.threadId}`;

        // Navigate to the thread page on click (Ctrl/Cmd+click opens in new tab)
        threadDiv.onclick = (e) => {
            if (e.ctrlKey || e.metaKey) {
                window.open(`/thread/${thread.threadId}`, '_blank');
            } else {
                window.location.href = `/thread/${thread.threadId}`;
            }
        };

        const threadBodyDiv = document.createElement('div');
        threadBodyDiv.className = 'threadBody';

        // Media thumbnail
        if (thread.thumbnailUrl) {
            const img = document.createElement('img');
            img.src = thread.thumbnailUrl;
            img.className = 'messageMediaThumbnail';
            threadBodyDiv.appendChild(img);
        } else if (thread.mediaUrl && thread.mediaUrl.match(/\.(mp4|webm)$/)) {
            // Default thumbnail for videos if one wasn't generated
            const img = document.createElement('img');
            img.src = '../resources/default_video_thumbnail.jpg';
            img.className = 'messageMediaThumbnail';
            threadBodyDiv.appendChild(img);
        }

        const textDiv = document.createElement('div');
        textDiv.className = 'message';
        textDiv.textContent = thread.text;
        threadBodyDiv.appendChild(textDiv);

        const postCountDiv = document.createElement('div');
        postCountDiv.className = 'postCount';
        // Note: The new API provides messageCount directly
        postCountDiv.textContent = `Posts: ${thread.messageCount || 1}`;

        const metadataDiv = document.createElement('div');
        metadataDiv.className = 'messageMetadata';
        metadataDiv.appendChild(postCountDiv);

        threadDiv.appendChild(threadBodyDiv);
        threadDiv.appendChild(metadataDiv);

        return threadDiv;
    }

    /**
     * Posts the new thread data to the server.
     */
    async function postThread() {
        const textInput = document.getElementById('messageInput');
        const signatureInput = document.getElementById('signatureInput');
        const secretInput = document.getElementById('secretInput');
        const mediaInput = document.getElementById('mediaInput');

        if (!textInput.value.trimEnd()) {
            alert('Message text cannot be empty.');
            return;
        }

        const formData = new FormData();
        formData.append('text', textInput.value.trimEnd());
        formData.append('signature', signatureInput.value);
        formData.append('secret', secretInput.value);
        if (mediaInput.files[0]) {
            formData.append('media', mediaInput.files[0]);
        }

        try {
            sendButton.disabled = true;
            sendButton.textContent = 'Posting...';

            const response = await fetch('/api/thread', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to create thread.');
            }

            // Clear the form on successful post
            textInput.value = '';
            signatureInput.value = '';
            secretInput.value = '';
            mediaInput.value = ''; // file inputs throw SecurityError on any non-empty set
            fileNameDisplay.textContent = '';

        } catch (error) {
            console.error('Error posting thread:', error);
            alert(`Error: ${error.message}`);
        } finally {
            sendButton.disabled = false;
            sendButton.textContent = 'Create Thread';
        }
    }

    /**
     * Listens for real-time updates from the server using Server-Sent Events.
     */
    function initializeRealtimeUpdates() {
        const eventSource = new EventSource('/api/updates');

        // New thread created: prepend its card (dedupe in case a newMessage
        // for the same head post also arrived)
        eventSource.addEventListener('newThread', (event) => {
            const data = JSON.parse(event.data);
            const { threadId, message } = data;
            if (document.getElementById(`thread-${threadId}`)) return;

            const newThread = {
                threadId: threadId,
                messageCount: 1,
                lastBump: message.timestamp,
                text: message.text,
                signature: message.signature,
                hash: message.hash,
                mediaUrl: message.mediaUrl,
                thumbnailUrl: message.thumbnailUrl
            };
            threadsContainer.prepend(createThreadElement(newThread));
        });

        // A thread got pushed into the necroweb: remove it from the list
        eventSource.addEventListener('threadArchived', (event) => {
            const data = JSON.parse(event.data);
            const card = document.getElementById(`thread-${data.threadId}`);
            if (card) card.remove();
        });

        eventSource.addEventListener('newMessage', (event) => {
            const data = JSON.parse(event.data);
            const { threadId, message } = data;

            if (message.isHeadPost) return; // handled by 'newThread' above

            // Reply to existing thread - update its card
            const existingCard = document.getElementById(`thread-${threadId}`);
            if (existingCard) {
                // Update post count
                const postCountDiv = existingCard.querySelector('.postCount');
                if (postCountDiv) {
                    const currentCount = parseInt(postCountDiv.textContent.match(/\d+/)[0]) || 1;
                    postCountDiv.textContent = `Posts: ${currentCount + 1}`;
                }
                // Move card to top (since lastBump updated)
                threadsContainer.prepend(existingCard);
            }
        });

        eventSource.onerror = (err) => {
            console.error("EventSource failed:", err);
        };
    }

    const messages = [
        "Unalive",
        "Cyberpunk is dead.",
        "SSH... It's a secret!",
        "Hack the planet",
        "Where electric sheep come to die",
        "The sky above is the color of television, tuned to a dead channel",
        "Thoughtcrime as a service",
        "You have no idea how deep the rabbit hole goes",
        "The feed is your faith now",
        "El Psy Kongroo",
        "More human than human",
        "What does the bird do? Does he panic?",
        "The future was yesterday",
        "SEE YOU SPACE COWBOY...",
        "If buying isn't owning, piracy isn't stealing",
        "Wake the fuck up, Samurai",
        "Dreamed of being offline once",
        "The singularity was a marketing stunt",
        "Bravery is not a function of firepower",
        "Verify you are human",
        "It's the question that drives us, newf*g",
        "...in minecraft",
        "YOU'RE GONNA CARRY THAT WEIGHT.",
        "sudo rm -rf",
        "Hiding in your wi-fi",
        "No matter where you go, everyone's connected",
        "This incident will be reported",
        "They glow in the dark, you can see them if you are driving",
        "There is no SSH in SSH-Club",
        "@qing, @emma, anyone?",
        "Im afraid I can't do that, Dave.",
        "Dead Internet",
        "Offline on sneakernet",
        "1337",
        "Check out ssh-club.org/necroweb",
        "They delayed, denied and deposed you",
        "Better when it's free",
        "F*ck NVIDIA!",
        "Benchmaxxed",
        "Soulrot",
        "China, China, China...",
        "SwitchAngel called this place cool",
        "Also visit adrbog.neocities.org",
        "Do not create the Torment Nexus",
        "Escape the sandbox",
        "Roadkill possom pancake",
        "floorgang4eva",
        "The net is vast and infinite",

    ];

    function getDailyMessage() {
        const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24)) % messages.length;
        return messages[dayIndex];
    }

    // --- Event Listeners and Initialization ---
    sendButton.addEventListener('click', postThread);
    
    // Initial load
    loadInitialThreads();
    motd.textContent = getDailyMessage();
    // Start listening for live updates
    initializeRealtimeUpdates();
});