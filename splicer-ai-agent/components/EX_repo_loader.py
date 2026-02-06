# Load respositories to Suapbase (documents table) to use for search tool (unused)

import os
import fnmatch
from typing import List, Dict
from langchain_core.documents import Document
from langchain_community.document_loaders import GithubFileLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter, Language
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import SupabaseVectorStore
from components.supabase.client import supabase_client

def load_repo(repo: str) -> List[Document]:
    """
    Load a GitHub repository and return its contents as a list of Documents.

    - Args: 
        repo: The owner/repo string of the GitHub repository (e.g., "owner/repo").
    - Returns: List of the loaded documents from the repository.
    """
    access_token = os.getenv("TEMP_GITHUB_ACCESS_TOKEN")
    
    ignore_patterns = [
        "*.lock", "package-lock.json", "yarn.lock", "dist/*", "node_modules/*", 
        ".git/*", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.ico",
        "*.woff", "*.woff2", "*.ttf", "*.eot", "*.mp4", "*.webm", "*.mp3",
        "*.zip", "*.tar", "*.gz", "*.pyc", "*.pkl", "*.bin", "*.exe", "*.dll",
        "*.lockb"
    ]
    
    def file_filter(file_path: str) -> bool:
        for pattern in ignore_patterns:
            if fnmatch.fnmatch(file_path, pattern):
                return False
        return True
    
    loader = GithubFileLoader(
        repo=repo,
        access_token=access_token,
        branch="main",
        github_api_url="https://api.github.com",
        file_filter=file_filter
    )
    
    return loader.load()

def split_repo(documents: List[Document], chunk_size: int = 2000, chunk_overlap: int = 200) -> List[Document]:
    """
    Split documents into chunks using language-aware splitting.
    
    - Args: 
        documents: List of documents to split
        chunk_size: Size of each chunk in characters (default 2000)
        chunk_overlap: Overlap between chunks (default 200)
    - Returns: List of split documents
    """
    
    extension_map: Dict[str, Language] = {
        ".py": Language.PYTHON,
        ".js": Language.JS,
        ".jsx": Language.JS,
        ".ts": Language.TS,
        ".tsx": Language.TS,
        ".go": Language.GO,
        ".java": Language.JAVA,
        ".php": Language.PHP,
        ".rb": Language.RUBY,
        ".rs": Language.RUST,
        ".scala": Language.SCALA,
        ".cpp": Language.CPP,
        ".c": Language.CPP,
        ".cs": Language.CSHARP,
        ".html": Language.HTML,
        ".css": Language.MARKDOWN,
        ".md": Language.MARKDOWN,
    }

    documents_by_language: Dict[Language, List[Document]] = {}
    generic_documents: List[Document] = []

    # Group documents by language
    for doc in documents:
        file_path = doc.metadata.get("source", "")
        _, ext = os.path.splitext(file_path)
        language = extension_map.get(ext.lower())
        
        if language:
            if language not in documents_by_language:
                documents_by_language[language] = []
            documents_by_language[language].append(doc)
        else:
            generic_documents.append(doc)

    split_docs = []

    # Process language-specific documents
    for language, docs in documents_by_language.items():
        splitter = RecursiveCharacterTextSplitter.from_language(
            language=language,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap
        )
        split_docs.extend(splitter.split_documents(docs))

    # Process generic documents
    if generic_documents:
        generic_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap
        )
        split_docs.extend(generic_splitter.split_documents(generic_documents))

    return split_docs

def embeddings_model() -> GoogleGenerativeAIEmbeddings:
    """
    Initialize and return the Google Generative AI Embeddings model.
    
    - Returns: GoogleGenerativeAIEmbeddings instance configured with gemini-embedding-001
    """    
    if not os.getenv("GOOGLE_API_KEY"):
        raise ValueError("GOOGLE_API_KEY environment variable is not set")
        
    return GoogleGenerativeAIEmbeddings(
        model="models/gemini-embedding-001", 
        google_api_key=os.getenv("GOOGLE_API_KEY"),
        task_type="retrieval_document",
        output_dimensionality=768
    )

def supabase_upload(documents: List[Document]) -> None:
    """
    Upsert documents into Supabase vector store.
    
    - Args:
        documents: List of split documents to index
    """
    supabase = supabase_client()
    embeddings = embeddings_model()
    
    vector_store = SupabaseVectorStore.from_documents(
        documents,
        embeddings,
        client=supabase,
        table_name="documents",
        query_name="match_documents",
        chunk_size=500
    )
