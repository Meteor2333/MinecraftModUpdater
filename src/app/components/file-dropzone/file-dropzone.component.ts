import { Component, OnDestroy, OnInit } from '@angular/core';
import { FilesService } from '../../services/files.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-file-dropzone',
  templateUrl: './file-dropzone.component.html',
  styleUrls: ['./file-dropzone.component.css'],
  standalone: false
})
export class FileDropzoneComponent implements OnInit, OnDestroy {
  files: File[] = [];
  subscription!: Subscription;

  constructor(private filesService: FilesService) {}

  ngOnInit() {
    this.subscription = this.filesService.files.subscribe((files) => {
      this.files = files;
    });
  }

  onSelect(event: { addedFiles: any }) {
    this.files = [...event.addedFiles];
    this.filesService.replaceFiles(this.files);
  }

  onRemove(event: File) {
    this.files.splice(this.files.indexOf(event), 1);
    this.filesService.setFiles(this.files);
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
  }
}
